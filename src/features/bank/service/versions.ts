// Restoring an older version of a question: a NEW version (author teacher, kind restored) that
// copies the chosen one, never a rewrite of history. The service connection does not enforce RLS
// and the `authenticated` role may not insert versions, so every statement names owner_id and the
// caller passes the service connection (as editQuestion does).
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  buildTraces,
  findPendingRegeneration,
  fromDbStatus,
  insertVerificationRun,
  isRegenerationMarker,
  loadObjectiveCodes,
  type AnyDb,
} from "@/features/generation";
import {
  loadVersionContent,
  projectReviewQuestion,
  type ReviewQuestion,
} from "@/features/review";
import type { QuestionStatus } from "@/features/verification";
import {
  questions,
  questionSources,
  questionVersions,
  verificationRuns,
} from "@/lib/db/schema";
import { err, ok, type Result } from "@/lib/result";
import { buildSearchText } from "@/lib/search/search-text";

export type RestoreFailure = "notFound" | "stale" | "trashed" | "notReady" | "current";

// Rolls the transaction back when the guarded UPDATE finds the question already changed.
class StaleRestore extends Error {}

/**
 * Copies `versionId` (content, claims, curriculum anchor and its latest verification) into version
 * max + 1 and makes it current. Approval follows the edit rules: an approved question that is not
 * banked goes back to draft; a banked one stays banked on the copy unless the copy is a mismatch,
 * then it goes back to review (VER-07). The row lock plus the guarded UPDATE is the optimistic lock.
 */
export async function restoreVersion(
  db: AnyDb,
  input: {
    ownerId: string;
    questionId: string;
    versionId: string;
    expectedRowVersion: number;
    now: Date;
  },
): Promise<Result<{ versionId: string }, RestoreFailure>> {
  const { ownerId, questionId, now } = input;
  try {
    return await db.transaction(
      async (tx): Promise<Result<{ versionId: string }, RestoreFailure>> => {
        const question = (
          await tx
            .select({
              currentVersionId: questions.currentVersionId,
              rowVersion: questions.rowVersion,
              status: questions.status,
              bankedAt: questions.bankedAt,
              deletedAt: questions.deletedAt,
              topicId: questions.topicId,
            })
            .from(questions)
            .where(and(eq(questions.id, questionId), eq(questions.ownerId, ownerId)))
            .limit(1)
            .for("update")
        ).at(0);
        if (!question?.currentVersionId) return err<RestoreFailure>("notFound");
        if (question.deletedAt !== null) return err<RestoreFailure>("trashed");
        if (question.rowVersion !== input.expectedRowVersion) {
          return err<RestoreFailure>("stale");
        }
        // A pending regeneration would put its new version on top of the restore.
        if (await findPendingRegeneration(tx, { ownerId, questionId })) {
          return err<RestoreFailure>("notReady");
        }
        // Restoring the version already shown would only duplicate it.
        if (input.versionId === question.currentVersionId) {
          return err<RestoreFailure>("current");
        }

        const source = (
          await tx
            .select()
            .from(questionVersions)
            .where(
              and(
                eq(questionVersions.id, input.versionId),
                eq(questionVersions.questionId, questionId),
                eq(questionVersions.ownerId, ownerId),
              ),
            )
            .limit(1)
        ).at(0);
        if (!source) return err<RestoreFailure>("notFound");

        const runs = await tx
          .select({
            verifierVersion: verificationRuns.verifierVersion,
            status: verificationRuns.status,
            checks: verificationRuns.checks,
            crossCheck: verificationRuns.crossCheck,
          })
          .from(verificationRuns)
          .where(
            and(
              eq(verificationRuns.questionVersionId, source.id),
              eq(verificationRuns.ownerId, ownerId),
            ),
          )
          .orderBy(asc(verificationRuns.createdAt), asc(verificationRuns.id));
        const latest = runs.filter((run) => !isRegenerationMarker(run.crossCheck)).at(-1);
        const status = fromDbStatus(
          latest ? latest.status : source.verificationStatus,
        ) as QuestionStatus;

        const nextNo =
          ((
            await tx
              .select({ n: sql<number>`max(${questionVersions.versionNo})` })
              .from(questionVersions)
              .where(
                and(
                  eq(questionVersions.questionId, questionId),
                  eq(questionVersions.ownerId, ownerId),
                ),
              )
          ).at(0)?.n ?? source.versionNo) + 1;

        const [version] = await tx
          .insert(questionVersions)
          .values({
            ownerId,
            questionId,
            versionNo: nextNo,
            author: "teacher",
            changeKind: "restored",
            difficulty: source.difficulty,
            stemMd: source.stemMd,
            options: source.options,
            answer: source.answer,
            explanationMd: source.explanationMd,
            steps: source.steps,
            answerRules: source.answerRules,
            verificationClaims: source.verificationClaims,
            verificationStatus: source.verificationStatus,
            generationRunId: source.generationRunId,
            createdAt: now,
          })
          .returning({ id: questionVersions.id });

        const sources = await tx
          .select()
          .from(questionSources)
          .where(
            and(
              eq(questionSources.questionVersionId, source.id),
              eq(questionSources.ownerId, ownerId),
            ),
          );
        if (sources.length > 0) {
          await tx.insert(questionSources).values(
            sources.map((row) => ({
              ownerId,
              questionVersionId: version.id,
              kind: row.kind,
              topicId: row.topicId,
              materialId: row.materialId,
              materialPageId: row.materialPageId,
              sectionId: row.sectionId,
              anchorLabel: row.anchorLabel,
              excerpt: row.excerpt,
              createdAt: now,
            })),
          );
        }

        // The copy is the same math: it carries the verification the restored version had.
        if (latest) {
          await insertVerificationRun(tx, {
            ownerId,
            versionId: version.id,
            verifierVersion: latest.verifierVersion,
            status,
            checks: latest.checks,
            crossCheck: latest.crossCheck,
            now,
          });
        }

        let approval: Partial<typeof questions.$inferInsert> = {};
        if (question.status === "approved") {
          approval =
            question.bankedAt !== null && status !== "ketidaksesuaian"
              ? { approvedVersionId: version.id, approvedAt: now, approvalOverride: null }
              : {
                  status: "draft",
                  approvedVersionId: null,
                  approvedAt: null,
                  approvalOverride: null,
                  bankedAt: null,
                };
        }

        const updated = await tx
          .update(questions)
          .set({
            ...approval,
            // The restored content comes back with the difficulty it was written for (R13).
            difficulty: source.difficulty,
            currentVersionId: version.id,
            searchText: buildSearchText({
              stemMd: source.stemMd,
              options: source.options,
              explanationMd: source.explanationMd,
              objectiveCodes: await loadObjectiveCodes(tx, question.topicId),
            }),
            rowVersion: sql`${questions.rowVersion} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(questions.id, questionId),
              eq(questions.ownerId, ownerId),
              eq(questions.rowVersion, input.expectedRowVersion),
              eq(questions.currentVersionId, question.currentVersionId),
            ),
          )
          .returning({ id: questions.id });
        if (updated.length === 0) throw new StaleRestore();

        return ok({ versionId: version.id });
      },
    );
  } catch (error) {
    if (error instanceof StaleRestore) return err<RestoreFailure>("stale");
    throw error;
  }
}

export interface VersionSummary {
  id: string;
  versionNo: number;
  author: string;
  changeKind: string;
  createdAt: string;
  status: QuestionStatus;
  isCurrent: boolean;
}

export interface VersionHistory {
  rowVersion: number;
  banked: boolean;
  versions: VersionSummary[];
}

// The question the history belongs to: this teacher's, not in the trash.
async function loadOwnQuestion(db: AnyDb, ownerId: string, questionId: string) {
  return (
    await db
      .select({
        currentVersionId: questions.currentVersionId,
        rowVersion: questions.rowVersion,
        topicId: questions.topicId,
        status: questions.status,
        bankedAt: questions.bankedAt,
      })
      .from(questions)
      .where(
        and(
          eq(questions.id, questionId),
          eq(questions.ownerId, ownerId),
          isNull(questions.deletedAt),
        ),
      )
      .limit(1)
  ).at(0);
}

/**
 * Every version of the question, newest first, with who made it, how, when and its verification
 * status (the latest real run, else the status stored on the version). Empty for an unknown,
 * foreign or trashed question.
 */
export async function listVersions(
  db: AnyDb,
  input: { ownerId: string; questionId: string },
): Promise<VersionSummary[]> {
  const question = await loadOwnQuestion(db, input.ownerId, input.questionId);
  return question ? listVersionsOf(db, input, question.currentVersionId) : [];
}

async function listVersionsOf(
  db: AnyDb,
  input: { ownerId: string; questionId: string },
  currentVersionId: string | null,
): Promise<VersionSummary[]> {
  const { ownerId, questionId } = input;
  const rows = await db
    .select({
      id: questionVersions.id,
      versionNo: questionVersions.versionNo,
      author: questionVersions.author,
      changeKind: questionVersions.changeKind,
      createdAt: questionVersions.createdAt,
      verificationStatus: questionVersions.verificationStatus,
    })
    .from(questionVersions)
    .where(
      and(
        eq(questionVersions.questionId, questionId),
        eq(questionVersions.ownerId, ownerId),
      ),
    )
    .orderBy(desc(questionVersions.versionNo));
  if (rows.length === 0) return [];
  const runs = await db
    .select({
      versionId: verificationRuns.questionVersionId,
      status: verificationRuns.status,
      crossCheck: verificationRuns.crossCheck,
    })
    .from(verificationRuns)
    .where(
      and(
        eq(verificationRuns.ownerId, ownerId),
        inArray(
          verificationRuns.questionVersionId,
          rows.map((row) => row.id),
        ),
      ),
    )
    .orderBy(asc(verificationRuns.createdAt), asc(verificationRuns.id));
  const latest = new Map<string, string>();
  for (const run of runs) {
    if (!isRegenerationMarker(run.crossCheck)) {
      latest.set(run.versionId, run.status);
    }
  }
  return rows.map((row) => ({
    id: row.id,
    versionNo: row.versionNo,
    author: row.author,
    changeKind: row.changeKind,
    createdAt: row.createdAt.toISOString(),
    status: fromDbStatus(latest.get(row.id) ?? row.verificationStatus) as QuestionStatus,
    isCurrent: row.id === currentVersionId,
  }));
}

/** The history with the row version a restore must quote. Null for unknown, foreign or trashed. */
export async function getVersionHistory(
  db: AnyDb,
  input: { ownerId: string; questionId: string },
): Promise<VersionHistory | null> {
  const question = await loadOwnQuestion(db, input.ownerId, input.questionId);
  if (!question) return null;
  const versions = await listVersionsOf(db, input, question.currentVersionId);
  if (versions.length === 0) return null;
  return {
    rowVersion: question.rowVersion,
    banked: question.status === "approved" && question.bankedAt !== null,
    versions,
  };
}

/** One version of the question as the teacher may read it (read-only). Null when not theirs. */
export async function getVersionQuestion(
  db: AnyDb,
  input: { ownerId: string; questionId: string; versionId: string },
): Promise<ReviewQuestion | null> {
  const { ownerId, questionId, versionId } = input;
  const question = await loadOwnQuestion(db, ownerId, questionId);
  if (!question) return null;
  const content = (await loadVersionContent(db, ownerId, [versionId])).at(0);
  if (content?.questionId !== questionId) return null;
  const trace = (
    await buildTraces(db, ownerId, [{ questionId, versionId, topicId: question.topicId }])
  ).at(0);
  return trace ? projectReviewQuestion(trace, content) : null;
}
