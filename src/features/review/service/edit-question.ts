// A teacher's edit of a question: a new, immutable version (author teacher, kind edited), checked
// again before it is shown. The service connection does not enforce RLS and the `authenticated`
// role may not insert versions, so every statement names owner_id and the caller passes the
// service connection (the generation pipeline writes versions the same way).
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  claimSchema,
  findPendingRegeneration,
  isRegenerationMarker,
  checkMultipleChoice,
  findInvalidMathSpans,
  insertVerificationRun,
  loadObjectiveCodes,
  toDbStatus,
  type AnyDb,
  type Claim,
  type MultipleChoiceQuestion,
} from "@/features/generation";
import {
  decideStatus,
  verifyClaims,
  VERIFIER_VERSION,
  type CrossCheckVerdict,
  type QuestionStatus,
} from "@/features/verification";
import {
  generationRequests,
  jobs,
  questions,
  questionSources,
  questionVersions,
  verificationRuns,
} from "@/lib/db/schema";
import { err, ok, type Result } from "@/lib/result";
import { buildSearchText } from "@/lib/search/search-text";
import type { EditInput } from "../schema/edit-input";

export type EditFailure =
  | { code: "notFound" | "stale" | "trashed" | "notReady" | "regenerating" }
  | { code: "invalid"; fields: string[] };

export interface EditSuccess {
  versionId: string;
  status: QuestionStatus;
}

// Rolls the transaction back when the guarded UPDATE finds the question already changed.
class StaleEdit extends Error {}

// Same terminal set as src/lib/jobs/client/status.ts (isTerminal).
const TERMINAL_JOB_STATUSES = ["succeeded", "failed", "cancelled"];

// Every field that holds math, in the order the form lists them, as the path the form uses.
function mathFields(content: EditInput): [string, string][] {
  return [
    ["stemMd", content.stemMd],
    ...content.options.map((option, i): [string, string] => [
      `options.${String(i)}.textMd`,
      option.textMd,
    ]),
    ["answerDisplayMd", content.answerDisplayMd],
    ["explanationMd", content.explanationMd],
    ...content.steps.map((step, i): [string, string] => [`steps.${String(i)}`, step]),
  ];
}

/** Paths of the fields whose `$...$` math does not parse (empty when all of it does). */
export function findInvalidEditFields(content: EditInput): string[] {
  return mathFields(content)
    .filter(([, text]) => findInvalidMathSpans(text).length > 0)
    .map(([path]) => path);
}

const storedContentSchema = z.object({
  options: z
    .array(z.object({ label: z.enum(["A", "B", "C", "D"]), text_md: z.string() }))
    .length(4),
  answer: z.object({
    display_md: z.string(),
    machine: z.string(),
    correctLabel: z.enum(["A", "B", "C", "D"]),
  }),
  steps: z.array(z.string()),
});

const keyText = (options: { label: string; text_md: string }[], key: string) =>
  options.find((option) => option.label === key)?.text_md.trim();

/**
 * Saves `content` as the next version of the question and re-checks it: the stored claims are kept
 * only while the question's math (stem, key option, final answer) is unchanged, since they describe
 * that math; the structural checks always run. Rules for the approval:
 * - an approved question that is not in the bank goes back to draft (an approval never carries
 *   over to different content);
 * - a banked question stays banked on the new version unless the checks find a mismatch, in which
 *   case it leaves the bank and goes back to review as a draft (VER-07).
 * Expected refusals come back as `err`; the row lock plus the guarded UPDATE is the optimistic lock.
 */
export async function editQuestion(
  db: AnyDb,
  input: {
    ownerId: string;
    questionId: string;
    expectedRowVersion: number;
    content: EditInput;
    now: Date;
  },
): Promise<Result<EditSuccess, EditFailure>> {
  const { ownerId, questionId, content, now } = input;
  try {
    return await db.transaction(async (tx): Promise<Result<EditSuccess, EditFailure>> => {
      const question = (
        await tx
          .select({
            currentVersionId: questions.currentVersionId,
            rowVersion: questions.rowVersion,
            status: questions.status,
            bankedAt: questions.bankedAt,
            deletedAt: questions.deletedAt,
            topicId: questions.topicId,
            difficulty: questions.difficulty,
            generationRequestId: questions.generationRequestId,
          })
          .from(questions)
          .where(and(eq(questions.id, questionId), eq(questions.ownerId, ownerId)))
          .limit(1)
          .for("update")
      ).at(0);
      if (!question?.currentVersionId) return err<EditFailure>({ code: "notFound" });
      if (question.deletedAt !== null) return err<EditFailure>({ code: "trashed" });
      // The pipeline may still verify or regenerate this question: wait for the job to finish.
      if (question.generationRequestId) {
        const job = (
          await tx
            .select({ status: jobs.status })
            .from(generationRequests)
            .innerJoin(
              jobs,
              and(eq(jobs.id, generationRequests.jobId), eq(jobs.ownerId, ownerId)),
            )
            .where(
              and(
                eq(generationRequests.id, question.generationRequestId),
                eq(generationRequests.ownerId, ownerId),
              ),
            )
            .limit(1)
        ).at(0);
        if (job && !TERMINAL_JOB_STATUSES.includes(job.status)) {
          return err<EditFailure>({ code: "notReady" });
        }
      }
      // A regeneration of this question would put its new version on top of the edit.
      if (await findPendingRegeneration(tx, { ownerId, questionId })) {
        return err<EditFailure>({ code: "regenerating" });
      }
      if (question.rowVersion !== input.expectedRowVersion) {
        return err<EditFailure>({ code: "stale" });
      }

      const fields = findInvalidEditFields(content);
      if (fields.length > 0) return err<EditFailure>({ code: "invalid", fields });

      const current = (
        await tx
          .select()
          .from(questionVersions)
          .where(
            and(
              eq(questionVersions.id, question.currentVersionId),
              eq(questionVersions.questionId, questionId),
              eq(questionVersions.ownerId, ownerId),
            ),
          )
          .limit(1)
      ).at(0);
      const stored = current ? storedContentSchema.safeParse(current) : null;
      if (!current || !stored?.success) return err<EditFailure>({ code: "notFound" });

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
        ).at(0)?.n ?? current.versionNo) + 1;

      const newKeyText = keyText(
        content.options.map((o) => ({ label: o.label, text_md: o.textMd })),
        content.correctLabel,
      );
      const mathChanged =
        content.stemMd !== current.stemMd.trim() ||
        content.answerDisplayMd !== stored.data.answer.display_md.trim() ||
        newKeyText !== keyText(stored.data.options, stored.data.answer.correctLabel);

      // The machine answer is never typed: it stays while the math stays, else it follows the key.
      const machine = mathChanged ? (newKeyText ?? "") : stored.data.answer.machine;
      const keyIndex = content.options.findIndex(
        (option) => option.label === content.correctLabel,
      );
      const claims: Claim[] = mathChanged
        ? []
        : (Array.isArray(current.verificationClaims) ? current.verificationClaims : [])
            .flatMap((raw: unknown) => {
              const parsed = claimSchema.safeParse(raw);
              return parsed.success ? [parsed.data] : [];
            })
            .map((claim) =>
              claim.type === "choice_matches_answer"
                ? {
                    ...claim,
                    options: content.options.map((option) => option.textMd),
                    markedIndex: keyIndex,
                    answer: machine,
                  }
                : claim,
            );

      const asQuestion: MultipleChoiceQuestion = {
        stem_md: content.stemMd,
        options: content.options.map((o) => ({ label: o.label, text_md: o.textMd })),
        correctLabel: content.correctLabel,
        answer: { display_md: content.answerDisplayMd, machine },
        explanation_md: content.explanationMd,
        steps: content.steps,
        verification_claims: claims,
        metadata: {
          difficulty:
            (["mudah", "sedang", "sulit"] as const).find(
              (value) => value === question.difficulty,
            ) ?? "sedang",
        },
      };
      const findings = checkMultipleChoice(asQuestion);
      const verdict = verifyClaims(claims);

      // The independent solver's verdict belongs to the math it solved: carried while the math is
      // unchanged (so a typo fix cannot turn a disagreement into "verified"), else unknown.
      let crossCheck: unknown = null;
      let crossVerdict: CrossCheckVerdict = "unknown";
      if (!mathChanged) {
        const runs = await tx
          .select({ crossCheck: verificationRuns.crossCheck })
          .from(verificationRuns)
          .where(
            and(
              eq(verificationRuns.questionVersionId, current.id),
              eq(verificationRuns.ownerId, ownerId),
            ),
          )
          .orderBy(asc(verificationRuns.createdAt), asc(verificationRuns.id));
        const prior = runs.filter((run) => !isRegenerationMarker(run.crossCheck)).at(-1);
        const priorVerdict = (prior?.crossCheck as { verdict?: unknown } | null)?.verdict;
        if (
          priorVerdict === "agree" ||
          priorVerdict === "disagree" ||
          priorVerdict === "unknown"
        ) {
          crossCheck = prior?.crossCheck ?? null;
          crossVerdict = priorVerdict;
        }
      }
      const status: QuestionStatus =
        findings.length > 0
          ? "ketidaksesuaian"
          : decideStatus(verdict.results, crossVerdict).status;

      const [version] = await tx
        .insert(questionVersions)
        .values({
          ownerId,
          questionId,
          versionNo: nextNo,
          author: "teacher",
          changeKind: "edited",
          difficulty: current.difficulty,
          stemMd: content.stemMd,
          options: asQuestion.options,
          answer: { ...asQuestion.answer, correctLabel: content.correctLabel },
          explanationMd: content.explanationMd,
          steps: content.steps,
          // Rules describe the old answer: they follow only an unchanged one.
          answerRules: mathChanged ? null : current.answerRules,
          verificationClaims: claims,
          verificationStatus: toDbStatus(status),
          generationRunId: null,
          createdAt: now,
        })
        .returning({ id: questionVersions.id });

      // The curriculum anchor belongs to each version (the trace reads it from the version).
      const sources = await tx
        .select()
        .from(questionSources)
        .where(
          and(
            eq(questionSources.questionVersionId, current.id),
            eq(questionSources.ownerId, ownerId),
          ),
        );
      if (sources.length > 0) {
        await tx.insert(questionSources).values(
          sources.map((source) => ({
            ownerId,
            questionVersionId: version.id,
            kind: source.kind,
            topicId: source.topicId,
            materialId: source.materialId,
            materialPageId: source.materialPageId,
            sectionId: source.sectionId,
            anchorLabel: source.anchorLabel,
            excerpt: source.excerpt,
            createdAt: now,
          })),
        );
      }

      await insertVerificationRun(tx, {
        ownerId,
        versionId: version.id,
        verifierVersion: VERIFIER_VERSION,
        status,
        checks: [
          ...verdict.results.map((result) => ({
            type: result.claim.type,
            status: result.status,
            detail: result.detail,
          })),
          ...findings.map((finding) => ({
            type: finding.code,
            status: "fail",
            detail: finding.message,
          })),
        ],
        crossCheck,
        now,
      });

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
          currentVersionId: version.id,
          searchText: buildSearchText({
            stemMd: content.stemMd,
            options: asQuestion.options,
            explanationMd: content.explanationMd,
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
            eq(questions.currentVersionId, current.id),
          ),
        )
        .returning({ id: questions.id });
      if (updated.length === 0) throw new StaleEdit();

      return ok<EditSuccess>({ versionId: version.id, status });
    });
  } catch (error) {
    if (error instanceof StaleEdit) return err<EditFailure>({ code: "stale" });
    throw error;
  }
}

export interface EditableQuestion {
  questionId: string;
  versionId: string;
  versionNo: number;
  rowVersion: number;
  // Approved now: saving an edit sends it back to review unless it is in the bank.
  approved: boolean;
  banked: boolean;
  content: EditInput;
}

/** The current version of an owned, non-trashed question in the shape the editor works on. */
export async function getEditableQuestion(
  db: AnyDb,
  input: { ownerId: string; questionId: string },
): Promise<EditableQuestion | null> {
  const row = (
    await db
      .select({
        version: questionVersions,
        rowVersion: questions.rowVersion,
        status: questions.status,
        bankedAt: questions.bankedAt,
      })
      .from(questions)
      .innerJoin(
        questionVersions,
        and(
          eq(questionVersions.id, questions.currentVersionId),
          eq(questionVersions.ownerId, questions.ownerId),
        ),
      )
      .where(
        and(
          eq(questions.id, input.questionId),
          eq(questions.ownerId, input.ownerId),
          sql`${questions.deletedAt} is null`,
        ),
      )
      .limit(1)
  ).at(0);
  const stored = row ? storedContentSchema.safeParse(row.version) : null;
  if (!row || !stored?.success) return null;
  return {
    questionId: input.questionId,
    versionId: row.version.id,
    versionNo: row.version.versionNo,
    rowVersion: row.rowVersion,
    approved: row.status === "approved",
    banked: row.status === "approved" && row.bankedAt !== null,
    content: {
      stemMd: row.version.stemMd,
      options: stored.data.options.map((option) => ({
        label: option.label,
        textMd: option.text_md,
      })),
      correctLabel: stored.data.answer.correctLabel,
      answerDisplayMd: stored.data.answer.display_md,
      explanationMd: row.version.explanationMd,
      steps: stored.data.steps,
    },
  };
}
