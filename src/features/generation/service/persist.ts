import { and, count, eq, inArray } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import type { AiUsage } from "@/lib/ai";
import {
  aiCalls,
  generationRequests,
  generationRuns,
  learningObjectives,
  questions,
  questionSources,
  questionVersions,
} from "@/lib/db/schema";
import { buildSearchText } from "@/lib/search/search-text";
import type { MultipleChoiceQuestion } from "../schema/schemas";
import { insertMaterialSources, type MaterialSourceRow } from "./material-sources";

export type AnyDb = PgAsyncDatabase<PgQueryResultHKT, AnyRelations>;

export type RequestRow = typeof generationRequests.$inferSelect;

export type RequestStatus =
  "queued" | "running" | "succeeded" | "partial" | "failed" | "deferred" | "cancelled";

const TASK = "generate_questions";

/**
 * The request must belong to the job's owner AND be the request this job was created for; the
 * payload only carries an id, and the service connection does not enforce RLS.
 */
export async function loadRequest(
  db: AnyDb,
  input: { requestId: string; ownerId: string; jobId: string },
): Promise<RequestRow | null> {
  const row = (
    await db
      .select()
      .from(generationRequests)
      .where(
        and(
          eq(generationRequests.id, input.requestId),
          eq(generationRequests.ownerId, input.ownerId),
          eq(generationRequests.jobId, input.jobId),
        ),
      )
      .limit(1)
  ).at(0);
  return row ?? null;
}

export async function countDrafts(
  db: AnyDb,
  input: { requestId: string; ownerId: string },
): Promise<number> {
  const row = (
    await db
      .select({ n: count() })
      .from(questions)
      .where(
        and(
          eq(questions.generationRequestId, input.requestId),
          eq(questions.ownerId, input.ownerId),
        ),
      )
  ).at(0);
  return row?.n ?? 0;
}

// Earlier attempts of this job whose repair was refused by the per-minute budget after tokens had
// been spent (see generate-batch.ts).
export async function countRepairDeferrals(
  db: AnyDb,
  input: { ownerId: string; jobId: string },
): Promise<number> {
  const row = (
    await db
      .select({ n: count() })
      .from(aiCalls)
      .where(
        and(
          eq(aiCalls.jobId, input.jobId),
          eq(aiCalls.ownerId, input.ownerId),
          eq(aiCalls.errorCode, "repair_deferred"),
        ),
      )
  ).at(0);
  return row?.n ?? 0;
}

// Earlier attempts of this job that a provider 429 deferred (see generate-batch.ts).
export async function countProviderDeferrals(
  db: AnyDb,
  input: { ownerId: string; jobId: string },
): Promise<number> {
  const row = (
    await db
      .select({ n: count() })
      .from(aiCalls)
      .where(
        and(
          eq(aiCalls.jobId, input.jobId),
          eq(aiCalls.ownerId, input.ownerId),
          eq(aiCalls.errorCode, "provider_rate_limited"),
        ),
      )
  ).at(0);
  return row?.n ?? 0;
}

export async function setRequestStatus(
  db: AnyDb,
  input: {
    requestId: string;
    ownerId: string;
    status: RequestStatus;
    from?: RequestStatus[];
    // When given, only the request created for that job is touched.
    jobId?: string;
    now: Date;
  },
): Promise<void> {
  await db
    .update(generationRequests)
    .set({ status: input.status, updatedAt: input.now })
    .where(
      and(
        eq(generationRequests.id, input.requestId),
        eq(generationRequests.ownerId, input.ownerId),
        input.from ? inArray(generationRequests.status, input.from) : undefined,
        input.jobId ? eq(generationRequests.jobId, input.jobId) : undefined,
      ),
    );
}

export async function insertAiCall(
  db: AnyDb,
  input: {
    ownerId: string;
    jobId: string;
    provider: string;
    model: string;
    promptVersion: string;
    usage: AiUsage;
    latencyMs: number;
    outcome: "ok" | "error";
    errorCode?: string;
    createdAt: Date;
    task?: string;
  },
): Promise<void> {
  await db.insert(aiCalls).values({
    ownerId: input.ownerId,
    jobId: input.jobId,
    task: input.task ?? TASK,
    provider: input.provider,
    model: input.model,
    promptVersion: input.promptVersion,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    cachedTokens: input.usage.cachedTokens ?? null,
    latencyMs: input.latencyMs,
    outcome: input.outcome,
    errorCode: input.errorCode ?? null,
    createdAt: input.createdAt,
  });
}

// The TP codes of a topic: part of every question's search text.
export async function loadObjectiveCodes(db: AnyDb, topicId: string): Promise<string[]> {
  const rows = await db
    .select({ code: learningObjectives.code })
    .from(learningObjectives)
    .where(eq(learningObjectives.topicId, topicId))
    .orderBy(learningObjectives.code);
  return rows.map((row) => row.code);
}

export interface PersistDraftsInput {
  ownerId: string;
  requestId: string;
  topicId: string;
  // The topic's source reference, stored as the traceability anchor of each question.
  sourceRef: string;
  grade: 8;
  // The teacher's choice; the model's own metadata.difficulty is not stored.
  difficulty: "mudah" | "sedang" | "sulit";
  run: {
    provider: string;
    model: string;
    promptVersion: string;
    curriculumVersionId: string;
    usage: AiUsage;
    latencyMs: number;
  };
  questions: MultipleChoiceQuestion[];
  // Material mode: per question (same index), its material citations, or null when its citations
  // were rejected: stored without any, so verification records the citation failure next to its
  // claim and cross-check results, and regenerates the question once.
  materialSources?: (MaterialSourceRow[] | null)[];
  now: Date;
}

/**
 * Writes one generation run and, per question, a draft, its first version and its curriculum
 * source. Call it inside a transaction: either everything is saved or nothing is. Statements are
 * ordered so the (deferrable) current_version_id link is set last.
 */
export async function persistDrafts(
  db: AnyDb,
  input: PersistDraftsInput,
): Promise<{ runId: string; questionIds: string[] }> {
  const [run] = await db
    .insert(generationRuns)
    .values({
      ownerId: input.ownerId,
      requestId: input.requestId,
      task: TASK,
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

  const objectiveCodes = await loadObjectiveCodes(db, input.topicId);
  const questionIds: string[] = [];
  for (const [index, draft] of input.questions.entries()) {
    const [question] = await db
      .insert(questions)
      .values({
        ownerId: input.ownerId,
        status: "draft",
        origin: "generated",
        grade: input.grade,
        type: "multiple_choice",
        difficulty: input.difficulty,
        topicId: input.topicId,
        generationRequestId: input.requestId,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning({ id: questions.id });

    const [version] = await db
      .insert(questionVersions)
      .values({
        ownerId: input.ownerId,
        questionId: question.id,
        versionNo: 1,
        author: "ai",
        changeKind: "generated",
        difficulty: input.difficulty,
        stemMd: draft.stem_md,
        options: draft.options,
        answer: { ...draft.answer, correctLabel: draft.correctLabel },
        explanationMd: draft.explanation_md,
        steps: draft.steps,
        answerRules: null,
        verificationClaims: draft.verification_claims,
        verificationStatus: "belum_dapat_diverifikasi",
        generationRunId: run.id,
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
      rows: input.materialSources?.[index] ?? [],
      now: input.now,
    });

    await db
      .update(questions)
      .set({
        currentVersionId: version.id,
        searchText: buildSearchText({
          stemMd: draft.stem_md,
          options: draft.options,
          explanationMd: draft.explanation_md,
          objectiveCodes,
        }),
      })
      .where(and(eq(questions.id, question.id), eq(questions.ownerId, input.ownerId)));

    questionIds.push(question.id);
  }

  return { runId: run.id, questionIds };
}
