// question_versions is immutable (trigger in drizzle/0002), so verification state lives in
// verification_runs; the status of a version is that of its latest real (non-marker) run.
import { and, asc, eq, inArray, isNotNull, isNull, type SQL } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { AiUsage } from "@/lib/ai";
import {
  generationRuns,
  questions,
  questionSources,
  questionVersions,
  verificationRuns,
} from "@/lib/db/schema";
import type { QuestionStatus } from "@/features/verification";
import { buildSearchText } from "@/lib/search/search-text";
import { loadObjectiveCodes, type AnyDb } from "./persist";
import type { MultipleChoiceQuestion } from "../schema/schemas";
import { fromDbStatus, isRegenerationMarker, toDbStatus } from "./verification-status";
import {
  DELETED_MATERIAL_ANCHOR,
  insertMaterialSources,
  type MaterialSourceRow,
} from "./material-sources";

const TASK = "generate_questions";

export interface StoredRun {
  status: string;
  checks: unknown;
  crossCheck: unknown;
}

export interface CurrentVersion {
  questionId: string;
  versionId: string;
  versionNo: number;
  stemMd: string;
  options: { label: string; text_md: string }[];
  answer: { display_md: string; machine: string; correctLabel: string };
  claims: unknown;
  // Effective status: that of the latest real run, or the column's creation value before any run.
  status: string;
  // The latest real verification run of this version (a regeneration marker is not one).
  run: StoredRun | null;
  // A regeneration of this version was attempted and recorded as failed.
  regenerationRecorded: boolean;
  // Its real material citations (rows citing a page): 0 for a material question whose citations
  // were rejected or whose material was gone, and for every topic question.
  materialSources: number;
  // It was written after its material was deleted (the placeholder source).
  materialGone: boolean;
}

// The current version of every question of one request, with the verification state it is in.
// Both filters name the owner: the service connection does not enforce RLS.
export async function listCurrentVersions(
  db: AnyDb,
  input: { requestId: string; ownerId: string },
): Promise<CurrentVersion[]> {
  return currentVersionsWhere(
    db,
    input.ownerId,
    eq(questions.generationRequestId, input.requestId),
  );
}

// The current version of one question (owner-filtered), or undefined.
export async function loadCurrentVersion(
  db: AnyDb,
  input: { questionId: string; ownerId: string },
): Promise<CurrentVersion | undefined> {
  return (
    await currentVersionsWhere(db, input.ownerId, eq(questions.id, input.questionId))
  ).at(0);
}

async function currentVersionsWhere(
  db: AnyDb,
  ownerId: string,
  where: SQL,
): Promise<CurrentVersion[]> {
  const rows = await db
    .select({
      questionId: questions.id,
      versionId: questionVersions.id,
      versionNo: questionVersions.versionNo,
      stemMd: questionVersions.stemMd,
      options: questionVersions.options,
      answer: questionVersions.answer,
      claims: questionVersions.verificationClaims,
      status: questionVersions.verificationStatus,
    })
    .from(questions)
    .innerJoin(
      questionVersions,
      and(
        eq(questionVersions.id, questions.currentVersionId),
        eq(questionVersions.ownerId, questions.ownerId),
      ),
    )
    .where(and(where, eq(questions.ownerId, ownerId)))
    .orderBy(asc(questions.createdAt), asc(questions.id));
  if (rows.length === 0) return [];

  const runs = await db
    .select({
      versionId: verificationRuns.questionVersionId,
      status: verificationRuns.status,
      checks: verificationRuns.checks,
      crossCheck: verificationRuns.crossCheck,
    })
    .from(verificationRuns)
    .where(
      and(
        eq(verificationRuns.ownerId, ownerId),
        inArray(
          verificationRuns.questionVersionId,
          rows.map((row) => row.versionId),
        ),
      ),
    )
    .orderBy(asc(verificationRuns.createdAt), asc(verificationRuns.id));

  const cited = await db
    .select({
      versionId: questionSources.questionVersionId,
      anchorLabel: questionSources.anchorLabel,
    })
    .from(questionSources)
    .where(
      and(
        eq(questionSources.ownerId, ownerId),
        eq(questionSources.kind, "material"),
        // Only real citations: a cited page. The "material deleted" placeholder cites none.
        isNotNull(questionSources.materialPageId),
        inArray(
          questionSources.questionVersionId,
          rows.map((row) => row.versionId),
        ),
      ),
    );

  // Versions written after their material was deleted carry the placeholder source.
  const placeholders = await db
    .select({ versionId: questionSources.questionVersionId })
    .from(questionSources)
    .where(
      and(
        eq(questionSources.ownerId, ownerId),
        eq(questionSources.kind, "material"),
        eq(questionSources.anchorLabel, DELETED_MATERIAL_ANCHOR),
        isNull(questionSources.materialId),
        inArray(
          questionSources.questionVersionId,
          rows.map((row) => row.versionId),
        ),
      ),
    );

  return rows.map((row) => {
    const own = runs.filter((run) => run.versionId === row.versionId);
    const real = own.filter((run) => !isRegenerationMarker(run.crossCheck));
    const latest = real.at(-1);
    return {
      questionId: row.questionId,
      versionId: row.versionId,
      versionNo: row.versionNo,
      stemMd: row.stemMd,
      options: row.options as CurrentVersion["options"],
      answer: row.answer as CurrentVersion["answer"],
      claims: row.claims,
      status: fromDbStatus(latest ? latest.status : row.status),
      run: latest
        ? {
            status: fromDbStatus(latest.status),
            checks: latest.checks,
            crossCheck: latest.crossCheck,
          }
        : null,
      regenerationRecorded: own.some((run) => isRegenerationMarker(run.crossCheck)),
      materialSources: cited.filter((source) => source.versionId === row.versionId)
        .length,
      materialGone: placeholders.some((source) => source.versionId === row.versionId),
    };
  });
}

export async function insertVerificationRun(
  db: AnyDb,
  input: {
    ownerId: string;
    versionId: string;
    verifierVersion: string;
    status: QuestionStatus;
    checks: unknown;
    crossCheck: unknown;
    now: Date;
  },
): Promise<void> {
  await db.insert(verificationRuns).values({
    ownerId: input.ownerId,
    questionVersionId: input.versionId,
    verifierVersion: input.verifierVersion,
    status: toDbStatus(input.status),
    checks: input.checks,
    crossCheck: input.crossCheck,
    createdAt: input.now,
  });
}

// A regeneration was tried and produced no usable version. Recorded as a verification-history row
// so that "once" survives a re-run (no schema change): it carries no checks and the same status.
export async function insertRegenerationMarker(
  db: AnyDb,
  input: { ownerId: string; versionId: string; now: Date },
): Promise<void> {
  await db.insert(verificationRuns).values({
    ownerId: input.ownerId,
    questionVersionId: input.versionId,
    verifierVersion: "regeneration",
    status: "ketidaksesuaian",
    checks: [],
    crossCheck: { regeneration: "failed" },
    createdAt: input.now,
  });
}

export interface PersistRegeneratedInput {
  ownerId: string;
  // The generation run hangs off a request; a question with none gets a version without a run.
  requestId: string | null;
  questionId: string;
  topicId: string;
  sourceRef: string;
  run: {
    provider: string;
    model: string;
    promptVersion: string;
    curriculumVersionId: string;
    usage: AiUsage;
    latencyMs: number;
  };
  question: MultipleChoiceQuestion;
  // The difficulty the new version was written for (stored on the version, R13).
  difficulty: "mudah" | "sedang" | "sulit";
  now: Date;
  // The pipeline's own regeneration is always version 2; a teacher's regeneration passes max + 1.
  versionNo?: number;
  // The generation run's task (a teacher's regeneration is `regenerate_question`).
  task?: string;
  // Further question columns set in the same UPDATE (approval, row version, difficulty).
  questionPatch?: PgUpdateSetSource<typeof questions>;
  // Material mode: the new version's validated material citations.
  materialSources?: MaterialSourceRow[];
}

// A regenerated version of an existing question (version 2 unless `versionNo` says otherwise). Call
// it inside a transaction (a savepoint): the unique (question_id, version_no) constraint turns a
// second regeneration of the same number into an error that rolls back.
export async function persistRegeneratedVersion(
  db: AnyDb,
  input: PersistRegeneratedInput,
): Promise<{ versionId: string; runId: string | null }> {
  const [run] =
    input.requestId === null
      ? [null]
      : await db
          .insert(generationRuns)
          .values({
            ownerId: input.ownerId,
            requestId: input.requestId,
            task: input.task ?? TASK,
            provider: input.run.provider,
            model: input.run.model,
            promptVersion: input.run.promptVersion,
            curriculumVersionId: input.run.curriculumVersionId,
            inputTokens: input.run.usage.inputTokens,
            outputTokens: input.run.usage.outputTokens,
            cachedTokens: input.run.usage.cachedTokens ?? null,
            latencyMs: input.run.latencyMs,
            outcome: "ok",
            createdAt: input.now,
          })
          .returning({ id: generationRuns.id });

  const [version] = await db
    .insert(questionVersions)
    .values({
      ownerId: input.ownerId,
      questionId: input.questionId,
      versionNo: input.versionNo ?? 2,
      author: "ai",
      changeKind: "regenerated",
      difficulty: input.difficulty,
      stemMd: input.question.stem_md,
      options: input.question.options,
      answer: { ...input.question.answer, correctLabel: input.question.correctLabel },
      explanationMd: input.question.explanation_md,
      steps: input.question.steps,
      answerRules: null,
      verificationClaims: input.question.verification_claims,
      verificationStatus: "belum_dapat_diverifikasi",
      generationRunId: run?.id ?? null,
      createdAt: input.now,
    })
    .returning({ id: questionVersions.id });

  await db.insert(questionSources).values({
    ownerId: input.ownerId,
    questionVersionId: version.id,
    kind: "curriculum",
    topicId: input.topicId,
    anchorLabel: input.sourceRef,
    excerpt: null,
    createdAt: input.now,
  });
  await insertMaterialSources(db, {
    ownerId: input.ownerId,
    versionId: version.id,
    rows: input.materialSources ?? [],
    now: input.now,
  });

  await db
    .update(questions)
    .set({
      ...input.questionPatch,
      currentVersionId: version.id,
      updatedAt: input.now,
      searchText: buildSearchText({
        stemMd: input.question.stem_md,
        options: input.question.options,
        explanationMd: input.question.explanation_md,
        objectiveCodes: await loadObjectiveCodes(db, input.topicId),
      }),
    })
    .where(and(eq(questions.id, input.questionId), eq(questions.ownerId, input.ownerId)));

  return { versionId: version.id, runId: run?.id ?? null };
}
