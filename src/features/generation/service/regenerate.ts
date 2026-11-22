import "server-only";
// A teacher's regeneration of ONE question: a new AI version (n + 1, kind regenerated) made from the
// same topic with an optional hint, then verified like any generated version (claims plus the
// independent cross-check). The service connection does not enforce RLS, so every statement names
// owner_id; the owner always comes from the session (request) or the job row (handler).
import { and, count, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  AiOutputError,
  AiPolicyError,
  AiProviderError,
  AiQuotaError,
  defaultRouting,
  type AiUsage,
  type TokenBudget,
} from "@/lib/ai";
import {
  aiCalls,
  generationRequests,
  jobs,
  questions,
  questionVersions,
  topics,
} from "@/lib/db/schema";
import { recordAudit } from "@/lib/events/recorders";
import {
  PermanentJobError,
  RetryableJobError,
  type HandlerResult,
  type JobContext,
  type JobHandler,
} from "@/lib/jobs/handler";
import { createJobQueue } from "@/lib/jobs/queue";
import type { Progress } from "@/lib/jobs/types";
import { logger } from "@/lib/logger";
import { err, ok, type Result } from "@/lib/result";
import { createCurriculumRepository } from "@/features/curriculum";
import {
  REGENERATE_JOB_TYPE,
  regeneratePayloadSchema,
  type RegenerateHint,
} from "../schema/regenerate-input";
import { AUDIT_QUESTION_REGENERATED } from "./audit";
import { buildContextPack } from "./context-pack";
import { parseMultipleChoiceBatch } from "./generate-mc";
import {
  countProviderDeferrals,
  countRepairDeferrals,
  insertAiCall,
  type AnyDb,
} from "./persist";
import {
  buildRegenerateMcPrompt,
  REGENERATE_MC_PROMPT_VERSION,
  sanitizeHintText,
  targetDifficulty,
} from "./prompts/regenerate-mc.id";
import {
  createGenerationBudget,
  estimateBatchTokens,
  GENERATE_QUOTA,
  jakartaDayWindow,
  planQuota,
  questionsRequestedToday,
  readRecentSpends,
  USER_DAILY_QUESTION_LIMIT,
} from "./quota";
import { hashSeed } from "./seeded-shuffle";
import { shuffleQuestionOptions } from "./shuffle-options";
import {
  aiErrorCode,
  lockWaitMs,
  MAX_PROVIDER_DEFERRALS,
  MIN_REMAINING_MS,
  OUTPUT_TOKENS_PER_QUESTION,
  pgCodeOf,
  providerRetryDelayMs,
  QUOTA_RETRY_MS,
  type Gateway,
} from "./step-support";
import { checkMultipleChoice } from "./structural-checks";
import { verifyVersion } from "./verify-batch";
import {
  materialSelectionSchema,
  type MaterialSelection,
} from "../schema/material-selection";
import { validateCitations } from "./citations";
import { buildMaterialContext } from "./material-context";
import { resolveMaterialSelection } from "./material-selection";
import {
  citationSources,
  DELETED_MATERIAL_SOURCE,
  type MaterialPack,
  type MaterialSourceRow,
} from "./material-sources";
import { materialContextBudget } from "./prompts/generate-mc.id";

// The material selection of the request a question was generated from, if it was a material
// request (owner-filtered).
async function requestMaterial(
  db: AnyDb,
  input: { ownerId: string; requestId: string | null },
): Promise<MaterialSelection | null> {
  if (input.requestId === null) return null;
  const row = (
    await db
      .select({
        mode: generationRequests.mode,
        selection: generationRequests.sourceSelection,
      })
      .from(generationRequests)
      .where(
        and(
          eq(generationRequests.id, input.requestId),
          eq(generationRequests.ownerId, input.ownerId),
        ),
      )
      .limit(1)
  ).at(0);
  if (row?.mode !== "material") return null;
  // Fail closed: a material request whose selection cannot be read is never a topic request.
  const parsed = materialSelectionSchema.safeParse(row.selection);
  if (!parsed.success) {
    throw new PermanentJobError(
      "invalid_params",
      "Parameter permintaan pembuatan soal tidak valid.",
    );
  }
  return parsed.data;
}
import { loadCurrentVersion, persistRegeneratedVersion } from "./verify-persist";

const TASK = "regenerate_question";
const ROUTE = defaultRouting.regenerate_question[0];
const ACTIVE_JOB_STATUSES = ["queued", "running", "deferred"];
// Same terminal set as src/lib/jobs/client/status.ts (isTerminal).
const TERMINAL_JOB_STATUSES = ["succeeded", "failed", "cancelled"];

type Difficulty = "mudah" | "sedang" | "sulit";
const DIFFICULTIES: readonly Difficulty[] = ["mudah", "sedang", "sulit"];

export interface RegenerateDeps {
  db: AnyDb;
  createGateway: (budget: TokenBudget) => Gateway;
  now?: () => Date;
}

export type RegenerateRequestFailure =
  | { reason: "not_found" | "trashed" | "not_ready" }
  | { reason: "pending"; jobId: string }
  | {
      reason: "daily_limit";
      limit: number;
      used: number;
      remaining: number;
      resetsAt: Date;
    };

export type RegenerateRequestResult = Result<
  { jobId: string; deferredUntil: Date | null },
  RegenerateRequestFailure
>;

/** The regeneration job of this question that has not finished yet, if any. */
export async function findPendingRegeneration(
  db: AnyDb,
  input: { ownerId: string; questionId: string },
): Promise<string | null> {
  const row = (
    await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.ownerId, input.ownerId),
          eq(jobs.type, REGENERATE_JOB_TYPE),
          inArray(jobs.status, ACTIVE_JOB_STATUSES),
          sql`${jobs.payload}->>'questionId' = ${input.questionId}`,
        ),
      )
      .limit(1)
  ).at(0);
  return row?.id ?? null;
}

// The hint as stored in the job: free text already cleaned and capped, an empty text as no hint.
function storedHint(hint: RegenerateHint): RegenerateHint {
  if (hint === null || typeof hint === "string") return hint;
  const text = sanitizeHintText(hint.text);
  return text ? { text } : null;
}

/**
 * Queues the regeneration of one of the owner's questions. Serialised with new generation requests
 * by the same per-owner advisory lock, it counts one question toward USER_DAILY_QUESTION_LIMIT (the
 * same count createGenerationRequest uses) and refuses while another regeneration of the question,
 * or the question's own generation job, is still running. When the shared AI quota is spent the
 * job is created `deferred` with `deferredUntil`.
 */
export async function requestRegeneration(
  db: AnyDb,
  input: { ownerId: string; questionId: string; hint: RegenerateHint; now: Date },
): Promise<RegenerateRequestResult> {
  const { ownerId, questionId, now } = input;
  return db.transaction(async (rawTx): Promise<RegenerateRequestResult> => {
    const tx = rawTx as unknown as AnyDb;
    // Relies on READ COMMITTED: each later statement sees what the previous holder committed.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`generation_request:${ownerId}`}, 0))`,
    );

    const question = (
      await tx
        .select({
          currentVersionId: questions.currentVersionId,
          deletedAt: questions.deletedAt,
          generationRequestId: questions.generationRequestId,
        })
        .from(questions)
        .where(and(eq(questions.id, questionId), eq(questions.ownerId, ownerId)))
        .limit(1)
    ).at(0);
    if (!question?.currentVersionId) {
      return err<RegenerateRequestFailure>({ reason: "not_found" });
    }
    if (question.deletedAt !== null) {
      return err<RegenerateRequestFailure>({ reason: "trashed" });
    }
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
        return err<RegenerateRequestFailure>({ reason: "not_ready" });
      }
    }
    const pending = await findPendingRegeneration(tx, { ownerId, questionId });
    if (pending)
      return err<RegenerateRequestFailure>({ reason: "pending", jobId: pending });

    const used = await questionsRequestedToday(tx, ownerId, now);
    if (used + 1 > USER_DAILY_QUESTION_LIMIT) {
      return err<RegenerateRequestFailure>({
        reason: "daily_limit",
        limit: USER_DAILY_QUESTION_LIMIT,
        used,
        remaining: Math.max(0, USER_DAILY_QUESTION_LIMIT - used),
        resetsAt: jakartaDayWindow(now).end,
      });
    }

    const plan = planQuota({
      spends: await readRecentSpends(tx, GENERATE_QUOTA.model, now),
      estimate: estimateBatchTokens(1),
      perDay: GENERATE_QUOTA.perDay,
      now,
    });
    const deferredUntil = plan.ok ? null : plan.error.resumeAt;
    const job = await createJobQueue(tx, () => now).enqueue({
      ownerId,
      type: REGENERATE_JOB_TYPE,
      payload: { questionId, hint: storedHint(input.hint) },
      status: deferredUntil ? "deferred" : "queued",
      runAfter: deferredUntil ?? now,
      // The daily count reads createdAt against `now`, so the row carries the same clock.
      createdAt: now,
    });
    return ok({ jobId: job.id, deferredUntil });
  });
}

// ── job handler ────────────────────────────────────────────────────────────────────────────

class PersistFailedError extends Error {}
class StructuralFailedError extends Error {}

type GenerateOutcome =
  | { kind: "created"; versionNo: number }
  | { kind: "already" }
  | { kind: "gone" }
  | { kind: "wait" }
  | { kind: "quota"; resumeAt: Date; reason: "quota_daily" | "quota_minute" }
  | { kind: "provider"; resumeAt: Date }
  | { kind: "failed"; error: unknown };

// The model call of this job is committed together with the new version, so a successful call
// recorded for the job means the version exists: a re-run goes straight to verification.
async function regenerationSaved(
  db: AnyDb,
  input: { ownerId: string; jobId: string },
): Promise<boolean> {
  const row = (
    await db
      .select({ n: count() })
      .from(aiCalls)
      .where(
        and(
          eq(aiCalls.jobId, input.jobId),
          eq(aiCalls.ownerId, input.ownerId),
          eq(aiCalls.task, TASK),
          eq(aiCalls.outcome, "ok"),
        ),
      )
  ).at(0);
  return (row?.n ?? 0) > 0;
}

function hintKind(hint: RegenerateHint): string {
  if (hint === null) return "none";
  return typeof hint === "string" ? hint : "text";
}

/** Job handler for `regenerate_question` (payload `{ questionId, hint }`). */
export function createRegenerateQuestionHandler(deps: RegenerateDeps): JobHandler {
  return (ctx) => regenerateQuestion(deps, ctx);
}

/**
 * One step of a regeneration: a new version from the model (once per job), then its verification,
 * then the approval is settled (R10: it moves to the new version only when that version is verified
 * or cross-checked, otherwise it is cleared). Idempotent per step. A trashed or unknown question
 * (including another owner's) makes the job a no-op: nothing is read from or written to it.
 */
export async function regenerateQuestion(
  deps: RegenerateDeps,
  ctx: JobContext,
): Promise<HandlerResult> {
  const payload = regeneratePayloadSchema.safeParse(ctx.job.payload);
  if (!payload.success) {
    throw new PermanentJobError(
      "invalid_payload",
      "Permintaan pembuatan ulang soal tidak valid.",
    );
  }
  try {
    return await run(deps, ctx, payload.data.questionId, payload.data.hint);
  } catch (error) {
    // The job ends here (a permanent error, or the last attempt): a version this job saved never
    // got its verification, so the old approval is not carried to it.
    const lastAttempt = ctx.job.attempts + 1 >= ctx.job.maxAttempts;
    if (error instanceof PermanentJobError || lastAttempt) {
      try {
        if (
          await regenerationSaved(deps.db, { ownerId: ctx.ownerId, jobId: ctx.job.id })
        ) {
          await settleRegenerationApproval(deps.db, {
            ownerId: ctx.ownerId,
            questionId: payload.data.questionId,
            now: (deps.now ?? (() => new Date()))(),
            jobEnded: true,
          });
        }
      } catch {
        // Best effort: never hide the original error.
      }
    }
    if (error instanceof PermanentJobError || error instanceof RetryableJobError)
      throw error;
    // Never the message or parameters: a database error can carry both.
    logger.error(
      { module: "generation", code: pgCodeOf(error) },
      "regenerate_question: step failed",
    );
    throw new RetryableJobError(
      "system_error",
      "Pembuatan ulang soal gagal karena kesalahan sistem.",
    );
  }
}

async function run(
  deps: RegenerateDeps,
  ctx: JobContext,
  questionId: string,
  hint: RegenerateHint,
): Promise<HandlerResult> {
  const now = deps.now ?? (() => new Date());
  const { db } = deps;
  const { ownerId, job } = ctx;
  const progress = (step: string, done: number, messageKey?: string): Progress => ({
    step,
    done,
    total: 1,
    ...(messageKey ? { messageKey } : {}),
  });
  const waiting = (): HandlerResult => ({
    kind: "defer",
    runAfter: new Date(ctx.deadline),
    progress: progress("waiting", 0),
  });

  const question = (
    await db
      .select({
        topicId: questions.topicId,
        difficulty: questions.difficulty,
        deletedAt: questions.deletedAt,
        generationRequestId: questions.generationRequestId,
      })
      .from(questions)
      .where(and(eq(questions.id, questionId), eq(questions.ownerId, ownerId)))
      .limit(1)
  ).at(0);
  if (question?.deletedAt !== null) {
    // Trashed after this job saved its version: settle the approval now (R19), so a restore from
    // the trash finds a consistent question.
    if (question && (await regenerationSaved(db, { ownerId, jobId: job.id }))) {
      await settleRegenerationApproval(db, {
        ownerId,
        questionId,
        now: now(),
        jobEnded: true,
      });
    }
    return { kind: "done", progress: progress("skipped", 0) };
  }

  if (!(await regenerationSaved(db, { ownerId, jobId: job.id }))) {
    if (ctx.deadline - now().getTime() < MIN_REMAINING_MS) return waiting();
    const outcome = await generateVersion(deps, ctx, {
      questionId,
      hint,
      topicId: question.topicId,
      difficulty: DIFFICULTIES.find((value) => value === question.difficulty) ?? "sedang",
      generationRequestId: question.generationRequestId,
    });
    switch (outcome.kind) {
      case "gone":
        return { kind: "done", progress: progress("skipped", 0) };
      case "wait":
        return waiting();
      case "quota":
        return {
          kind: "defer",
          runAfter: outcome.resumeAt,
          progress: progress("deferred", 0, outcome.reason),
        };
      case "provider":
        return {
          kind: "defer",
          runAfter: outcome.resumeAt,
          progress: progress("deferred", 0, "provider_rate_limited"),
        };
      case "failed":
        throw jobErrorFor(outcome.error);
      case "created":
        // Committed: audited once (a re-run sees the saved call and never gets here).
        await recordAudit(db, {
          ownerId,
          action: AUDIT_QUESTION_REGENERATED,
          entityType: "question",
          entityId: questionId,
          metadata: {
            versionNo: outcome.versionNo,
            reason: "requested",
            hint: hintKind(hint),
          },
        });
        break;
      case "already":
        break;
    }
  }

  // Trashed after the version was saved: no cross-check is spent on it, and the approval is
  // settled now (R19).
  if (!(await isLive(db, { ownerId, questionId }))) {
    await settleRegenerationApproval(db, {
      ownerId,
      questionId,
      now: now(),
      jobEnded: true,
    });
    return { kind: "done", progress: progress("skipped", 0) };
  }
  // Verification of the current version (the new one, unless the teacher changed it since: an
  // edited or restored version already carries its run).
  const current = await loadCurrentVersion(db, { questionId, ownerId });
  if (!current) return { kind: "done", progress: progress("skipped", 0) };
  const material =
    (await requestMaterial(db, {
      ownerId,
      requestId: question.generationRequestId,
    })) !== null;
  if (current.run === null) {
    if (ctx.deadline - now().getTime() < MIN_REMAINING_MS) return waiting();
    const unit = await verifyVersion(
      { db, createGateway: deps.createGateway, now },
      {
        ownerId,
        jobId: job.id,
        deadline: ctx.deadline,
        // The new version's stem is the teacher's draft (C1), or material-derived (C2).
        dataClass: material ? "C2" : "C1",
        requireCitations: material,
        reload: (tx) => loadCurrentVersion(tx, { questionId, ownerId }),
      },
      current,
    );
    if (unit.kind === "defer") {
      if (unit.reason === "time") return waiting();
      return {
        kind: "defer",
        runAfter: unit.runAfter,
        progress: progress(
          "deferred",
          0,
          unit.reason === "provider" ? "provider_rate_limited" : unit.reason,
        ),
      };
    }
  }

  const settled = await settleRegenerationApproval(db, {
    ownerId,
    questionId,
    now: now(),
  });
  return {
    kind: "done",
    progress: progress(settled === "left_bank" ? "returned_to_review" : "saved", 1),
  };
}

async function isLive(
  db: AnyDb,
  input: { ownerId: string; questionId: string },
): Promise<boolean> {
  const row = (
    await db
      .select({ id: questions.id })
      .from(questions)
      .where(
        and(
          eq(questions.id, input.questionId),
          eq(questions.ownerId, input.ownerId),
          isNull(questions.deletedAt),
        ),
      )
      .limit(1)
  ).at(0);
  return row !== undefined;
}

const SOUND_STATUSES = ["terverifikasi", "dicek_silang"];

/**
 * R10 (revised) and R19: the approval of a regenerated banked question stays on the old version
 * while the job runs (the bank keeps showing that version). Once the new (current) version has a
 * verification run, the approval moves to it when it is verified or cross-checked; otherwise
 * (mismatch, no signal) the approval and banked_at are cleared and the question goes back to review.
 * When the job ends with no run (`jobEnded`: last attempt, cancelled by trash, skipped because
 * trashed, swept) it is cleared too. A trashed question is settled as well, so a restore from the
 * trash is consistent. Guarded on the approved and current version ids, so a teacher change in
 * between is left alone. Returns what happened.
 */
export async function settleRegenerationApproval(
  db: AnyDb,
  input: { ownerId: string; questionId: string; now: Date; jobEnded?: boolean },
): Promise<"none" | "moved" | "cleared" | "left_bank"> {
  const row = (
    await db
      .select({
        status: questions.status,
        approvedVersionId: questions.approvedVersionId,
        currentVersionId: questions.currentVersionId,
        bankedAt: questions.bankedAt,
      })
      .from(questions)
      .where(
        and(eq(questions.id, input.questionId), eq(questions.ownerId, input.ownerId)),
      )
      .limit(1)
  ).at(0);
  if (
    row?.status !== "approved" ||
    row.approvedVersionId === null ||
    row.approvedVersionId === row.currentVersionId
  ) {
    return "none";
  }
  const current = await loadCurrentVersion(db, input);
  if (current?.versionId !== row.currentVersionId) return "none";
  if (current.run === null && !input.jobEnded) return "none";

  const sound = current.run !== null && SOUND_STATUSES.includes(current.run.status);
  const guard = and(
    eq(questions.id, input.questionId),
    eq(questions.ownerId, input.ownerId),
    eq(questions.status, "approved"),
    eq(questions.approvedVersionId, row.approvedVersionId),
    eq(questions.currentVersionId, current.versionId),
  );
  const updated = await db
    .update(questions)
    .set(
      sound
        ? {
            approvedVersionId: current.versionId,
            approvedAt: input.now,
            approvalOverride: null,
            rowVersion: sql`${questions.rowVersion} + 1`,
            updatedAt: input.now,
          }
        : {
            status: "draft",
            approvedVersionId: null,
            approvedAt: null,
            approvalOverride: null,
            bankedAt: null,
            rowVersion: sql`${questions.rowVersion} + 1`,
            updatedAt: input.now,
          },
    )
    .where(guard)
    .returning({ id: questions.id });
  if (updated.length === 0) return "none";
  if (sound) return "moved";
  return row.bankedAt !== null ? "left_bank" : "cleared";
}

function jobErrorFor(error: unknown): Error {
  if (error instanceof StructuralFailedError) {
    return new RetryableJobError(
      "structural_failed",
      "Tidak ada soal yang lolos pemeriksaan struktur.",
    );
  }
  if (error instanceof AiPolicyError) {
    return new PermanentJobError(error.code, error.message);
  }
  if (error instanceof AiOutputError) {
    return new RetryableJobError(
      "invalid_output",
      "Keluaran AI tidak valid setelah perbaikan.",
    );
  }
  if (error instanceof PersistFailedError) {
    return new RetryableJobError(
      "persist_failed",
      "Versi baru soal tidak dapat disimpan.",
    );
  }
  if (error instanceof AiProviderError && error.kind === "rate_limited") {
    return new RetryableJobError(
      "provider_busy",
      "Layanan AI masih membatasi permintaan.",
    );
  }
  if (error instanceof AiProviderError && error.kind === "auth_failed") {
    return new PermanentJobError(
      "provider_misconfigured",
      "Layanan AI belum diatur dengan benar.",
    );
  }
  return new RetryableJobError(
    "provider_unavailable",
    "Layanan AI sedang tidak dapat dijangkau.",
  );
}

async function generateVersion(
  deps: RegenerateDeps,
  ctx: JobContext,
  target: {
    questionId: string;
    hint: RegenerateHint;
    topicId: string;
    difficulty: Difficulty;
    generationRequestId: string | null;
  },
): Promise<GenerateOutcome> {
  const now = deps.now ?? (() => new Date());
  const { db } = deps;
  const { ownerId, job } = ctx;
  const { questionId, hint } = target;

  // The question's topic in the curriculum version it belongs to (shared curriculum, no owner).
  const versionRow = (
    await db
      .select({ versionId: topics.curriculumVersionId })
      .from(topics)
      .where(eq(topics.id, target.topicId))
      .limit(1)
  ).at(0);
  const topic = versionRow
    ? await createCurriculumRepository(db).getTopicInVersion(
        target.topicId,
        versionRow.versionId,
      )
    : null;
  if (!topic) {
    throw new PermanentJobError(
      "topic_not_found",
      "Topik untuk soal ini tidak ditemukan.",
    );
  }
  const previous = await loadCurrentVersion(db, { questionId, ownerId });
  if (!previous) return { kind: "gone" };
  // A material question is written again from its material (C2), and must cite it; once the
  // material is gone it is written from the topic and its source says so.
  const selection = await requestMaterial(db, {
    ownerId,
    requestId: target.generationRequestId,
  });
  let material: MaterialPack | null = null;
  // Only a material that no longer exists (deleted, trashed) is written without it, and its
  // source says so; a live one that cannot be used or no longer matches refuses.
  let materialGone = false;
  if (selection) {
    const resolved = await resolveMaterialSelection(db, { ownerId, selection });
    if (!resolved.ok && resolved.error !== "material") {
      throw new PermanentJobError(
        "material_unavailable",
        "Materi sumber tidak dapat dipakai.",
      );
    }
    materialGone = !resolved.ok;
  }
  if (selection && !materialGone) {
    const context = await buildMaterialContext(db, {
      ownerId,
      materialId: selection.materialId,
      selection,
      topicId: topic.id,
      maxTokens: materialContextBudget(1),
    });
    if (context.unrelated) {
      throw new PermanentJobError(
        "material_unrelated",
        "Halaman materi yang dipilih tidak membahas topik ini.",
      );
    }
    if (context.passages.length === 0) {
      throw new PermanentJobError(
        "material_unavailable",
        "Materi sumber tidak dapat dipakai.",
      );
    }
    material = { materialId: selection.materialId, passages: context.passages };
  }
  // C1: the prompt carries the teacher's draft question and hint, so only zero-retention routes;
  // C2 for a material question (its stem and passages are the teacher's material).
  const pack = {
    ...buildContextPack(topic, { difficulty: target.difficulty, quantity: 1 }),
    dataClass: selection ? ("C2" as const) : ("C1" as const),
    ...(material
      ? {
          passages: material.passages.map((passage) => ({
            id: passage.id,
            text: passage.text,
          })),
        }
      : {}),
  };
  const { system, prompt } = buildRegenerateMcPrompt({
    pack,
    previousStemMd: previous.stemMd,
    hint,
  });
  const difficulty = targetDifficulty(target.difficulty, hint);
  const waitMs = lockWaitMs(ctx.deadline, now().getTime());

  try {
    return await db.transaction(async (rawTx): Promise<GenerateOutcome> => {
      const tx = rawTx as unknown as AnyDb;
      // Same model lock and budget as batch generation (the routes are the same models).
      await tx.execute(sql.raw(`set local lock_timeout = '${String(waitMs)}ms'`));
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`ai:${GENERATE_QUOTA.model}`}, 0))`,
      );
      await tx.execute(sql.raw("set local lock_timeout = 0"));

      // Another run of this job may have saved the version while this one waited.
      if (await regenerationSaved(tx, { ownerId, jobId: job.id }))
        return { kind: "already" };
      if (ctx.deadline - now().getTime() < MIN_REMAINING_MS) return { kind: "wait" };

      const spends = await readRecentSpends(tx, GENERATE_QUOTA.model, now());
      const plan = planQuota({
        spends,
        estimate: estimateBatchTokens(1),
        perDay: GENERATE_QUOTA.perDay,
        now: now(),
      });
      if (!plan.ok) {
        return { kind: "quota", resumeAt: plan.error.resumeAt, reason: "quota_daily" };
      }

      const spent: AiUsage = { inputTokens: 0, outputTokens: 0 };
      const startedAt = now().getTime();
      const record = (
        outcome: "ok" | "error",
        errorCode?: string,
        provider = ROUTE.provider,
        model = ROUTE.model,
      ) =>
        insertAiCall(tx, {
          ownerId,
          jobId: job.id,
          task: TASK,
          provider,
          model,
          promptVersion: REGENERATE_MC_PROMPT_VERSION,
          usage: spent,
          latencyMs: now().getTime() - startedAt,
          outcome,
          errorCode,
          createdAt: now(),
        });

      let result;
      try {
        result = await deps
          .createGateway(createGenerationBudget(spends, () => now().getTime()))
          .generate({
            task: TASK,
            dataClass: pack.dataClass,
            system,
            prompt,
            maxOutputTokens: OUTPUT_TOKENS_PER_QUESTION,
            onUsage: (usage) => {
              spent.inputTokens += usage.inputTokens;
              spent.outputTokens += usage.outputTokens;
              if (usage.cachedTokens !== undefined) {
                spent.cachedTokens = (spent.cachedTokens ?? 0) + usage.cachedTokens;
              }
            },
            parse: parseMultipleChoiceBatch,
          });
      } catch (error) {
        const paid = spent.inputTokens + spent.outputTokens > 0;
        // A provider 429 is a wait (bounded per job), not a failure.
        if (error instanceof AiProviderError && error.kind === "rate_limited") {
          const earlier = await countProviderDeferrals(tx, { ownerId, jobId: job.id });
          const capped = earlier >= MAX_PROVIDER_DEFERRALS;
          await record("error", capped ? "provider_busy" : "provider_rate_limited");
          if (capped) return { kind: "failed", error };
          return {
            kind: "provider",
            resumeAt: new Date(
              now().getTime() + providerRetryDelayMs(error.retryAfterMs),
            ),
          };
        }
        if (error instanceof AiQuotaError) {
          // A refused repair after a paid attempt may wait once; a second time it fails the attempt
          // instead of paying for the first call again and again (generate-batch.ts does the same).
          if (paid && (await countRepairDeferrals(tx, { ownerId, jobId: job.id })) > 0) {
            await record("error", "invalid_output");
            return {
              kind: "failed",
              error: new AiOutputError("Keluaran AI tidak valid setelah perbaikan."),
            };
          }
          await record("error", paid ? "repair_deferred" : "quota_deferred");
          return {
            kind: "quota",
            resumeAt: new Date(now().getTime() + QUOTA_RETRY_MS),
            reason: "quota_minute",
          };
        }
        await record("error", aiErrorCode(error));
        return { kind: "failed", error };
      }

      // The first returned question that passes the structural checks.
      const candidate = result.value.questions.find(
        (item) => checkMultipleChoice(item).length === 0,
      );
      if (!candidate) {
        await record("error", "structural_failed", result.provider, result.model);
        return { kind: "failed", error: new StructuralFailedError() };
      }
      // Shuffled before it is saved (versions are immutable), seeded by the job so a retry agrees.
      const question = shuffleQuestionOptions(candidate, hashSeed(`regen:${job.id}`));
      // Valid citations become its sources; invented ones are dropped (verification then marks
      // it unverifiable). Without a usable material: the "deleted" source.
      let materialSources: MaterialSourceRow[] | undefined;
      if (material) {
        const citations = validateCitations(
          question,
          material.passages.map((passage) => passage.id),
        );
        materialSources = citations.ok ? citationSources(material, citations.data) : [];
      } else if (materialGone) {
        materialSources = [DELETED_MATERIAL_SOURCE];
      }

      let saved: { versionNo: number } | "gone";
      try {
        saved = await tx.transaction(
          async (savepoint): Promise<{ versionNo: number } | "gone"> => {
            const row = (
              await savepoint
                .select({
                  deletedAt: questions.deletedAt,
                  status: questions.status,
                  bankedAt: questions.bankedAt,
                })
                .from(questions)
                .where(and(eq(questions.id, questionId), eq(questions.ownerId, ownerId)))
                .limit(1)
                .for("update")
            ).at(0);
            // Trashed (or purged) while the model was answering: never resurrect it.
            if (row?.deletedAt !== null) return "gone";

            const versionNo =
              ((
                await savepoint
                  .select({ n: sql<number>`max(${questionVersions.versionNo})` })
                  .from(questionVersions)
                  .where(
                    and(
                      eq(questionVersions.questionId, questionId),
                      eq(questionVersions.ownerId, ownerId),
                    ),
                  )
              ).at(0)?.n ?? 0) + 1;

            await persistRegeneratedVersion(savepoint, {
              ownerId,
              requestId: target.generationRequestId,
              questionId,
              topicId: topic.id,
              sourceRef: topic.sourceRef,
              run: {
                provider: result.provider,
                model: result.model,
                promptVersion: REGENERATE_MC_PROMPT_VERSION,
                curriculumVersionId: topic.version.id,
                usage: spent,
                latencyMs: now().getTime() - startedAt,
              },
              question,
              difficulty,
              now: now(),
              versionNo,
              task: TASK,
              ...(materialSources ? { materialSources } : {}),
              questionPatch: {
                difficulty,
                rowVersion: sql`${questions.rowVersion} + 1`,
              },
            });

            // R19: an approval outside the bank goes back to draft, like a teacher edit. A banked one
            // stays on the old version (still shown in the bank) until the new one is verified (R10).
            if (row.status === "approved" && row.bankedAt === null) {
              await savepoint
                .update(questions)
                .set({
                  status: "draft",
                  approvedVersionId: null,
                  approvedAt: null,
                  approvalOverride: null,
                })
                .where(and(eq(questions.id, questionId), eq(questions.ownerId, ownerId)));
            }
            return { versionNo };
          },
        );
      } catch {
        await record("error", "persist_failed", result.provider, result.model);
        return { kind: "failed", error: new PersistFailedError() };
      }
      if (saved === "gone") {
        // The tokens were spent: recorded, but not as a saved regeneration.
        await record("error", "question_gone", result.provider, result.model);
        return { kind: "gone" };
      }
      await record("ok", undefined, result.provider, result.model);
      return { kind: "created", versionNo: saved.versionNo };
    });
  } catch (error) {
    if (pgCodeOf(error) !== "55P03") throw error;
    return { kind: "wait" };
  }
}

/**
 * The safety net of R19, run by the daily jobs run: a banked question whose approval still sits
 * on an older version while no regeneration of it can still run (its job died by timeout or lease
 * expiry on the last attempt, so no handler settled it) is settled as an ended job. All owners
 * (service connection); every statement after the scan names the row's owner. Returns how many
 * questions it changed.
 */
export async function settleStrandedApprovals(db: AnyDb, now: Date): Promise<number> {
  const stranded = await db
    .select({ id: questions.id, ownerId: questions.ownerId })
    .from(questions)
    .where(
      and(
        eq(questions.status, "approved"),
        isNotNull(questions.bankedAt),
        isNotNull(questions.approvedVersionId),
        sql`${questions.approvedVersionId} <> ${questions.currentVersionId}`,
        sql`not exists (
          select 1 from ${jobs}
          where ${jobs.ownerId} = ${questions.ownerId}
            and ${jobs.type} = ${REGENERATE_JOB_TYPE}
            and ${jobs.status} in ('queued', 'running', 'deferred')
            and ${jobs.payload}->>'questionId' = ${questions.id}::text
        )`,
      ),
    )
    .limit(200);
  let settled = 0;
  for (const row of stranded) {
    const outcome = await settleRegenerationApproval(db, {
      ownerId: row.ownerId,
      questionId: row.id,
      now,
      jobEnded: true,
    });
    if (outcome !== "none") settled += 1;
  }
  return settled;
}
