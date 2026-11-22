import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  AiOutputError,
  AiPolicyError,
  AiProviderError,
  AiQuotaError,
  defaultRouting,
  type AiUsage,
  type TokenBudget,
} from "@/lib/ai";
import { recordAudit, recordUsage } from "@/lib/events/recorders";
import {
  PermanentJobError,
  RetryableJobError,
  type HandlerResult,
  type JobContext,
  type JobHandler,
} from "@/lib/jobs/handler";
import type { Progress } from "@/lib/jobs/types";
import { createCurriculumRepository } from "@/features/curriculum";
import { AUDIT_DRAFTS_GENERATED } from "./audit";
import { buildContextPack } from "./context-pack";
import { generateMultipleChoiceBatch } from "./generate-mc";
import {
  countDrafts,
  countProviderDeferrals,
  countRepairDeferrals,
  insertAiCall,
  loadRequest,
  persistDrafts,
  setRequestStatus,
  type AnyDb,
} from "./persist";
import {
  materialContextBudget,
  promptVersionOf,
  type GenerateMcParams,
} from "./prompts/generate-mc.id";
import {
  materialSelectionSchema,
  type MaterialSelection,
} from "../schema/material-selection";
import { validateCitations } from "./citations";
import { buildMaterialContext } from "./material-context";
import { citationSources, type MaterialPack } from "./material-sources";
import type { TopicDetail } from "@/features/curriculum";
import {
  createGenerationBudget,
  estimateBatchTokens,
  GENERATE_QUOTA,
  planQuota,
  readRecentSpends,
} from "./quota";
import { generationParamsSchema } from "./request-params";
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
import { checkMultipleChoice, type StructuralFinding } from "./structural-checks";
import { verifyRequest, type StatusCounts } from "./verify-batch";
import { logger } from "@/lib/logger";

export type { Gateway };

export interface GenerateBatchDeps {
  db: AnyDb;
  createGateway: (budget: TokenBudget) => Gateway;
  now?: () => Date;
  // Run the verification phase (claims, cross-check, regeneration) after the drafts are saved.
  // Default true; only the generation-only tests turn it off.
  verify?: boolean;
}

const payloadSchema = z.object({ requestId: z.guid() });
const PRIMARY_ROUTE = defaultRouting.generate_questions[0];

// Raised inside the handler when the drafts could not be written; its text is never shown.
class PersistFailedError extends Error {}

// Every error this handler throws on purpose is a RetryableJobError: a fixed, sanitized message and
// a code the status page maps to copy. Anything else (for example a database error) is replaced by
// one of these before it can be stored.

// The model answered, but no returned question survived the structural checks. It carries counts
// only (never question text) so the failure event can say what was wrong.
class StructuralFailedError extends RetryableJobError {
  rejected: number;
  findings: Record<string, number>;
  constructor(rejected: number, findings: Record<string, number>) {
    super("structural_failed", "Tidak ada soal yang lolos pemeriksaan struktur.");
    this.rejected = rejected;
    this.findings = findings;
  }
}

function countFindings(findings: StructuralFinding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) counts[finding.code] = (counts[finding.code] ?? 0) + 1;
  return counts;
}

type CallOutcome =
  | { kind: "already_saved"; count: number }
  | { kind: "wait" }
  | { kind: "deferred"; resumeAt: Date; messageKey: "quota_daily" }
  | { kind: "quota"; resumeAt: Date; messageKey: "quota_daily" | "quota_minute" }
  | { kind: "provider_limited"; resumeAt: Date }
  | {
      kind: "saved";
      count: number;
      durationMs: number;
      rejected: number;
      findings: Record<string, number>;
    }
  | { kind: "failed"; error: unknown };

function errorCodeOf(error: unknown): string {
  return error instanceof PersistFailedError ? "persist_failed" : aiErrorCode(error);
}

/**
 * Job handler for `generate_batch`: loads the request (owner and job must match), generates a
 * batch through the gateway, saves drafts atomically, then runs verification. Idempotent per step:
 * the runner may repeat it after a crash. Quota or provider limits end in a `defer`, a bad request
 * in a `PermanentJobError`, other failures in a retry.
 */
export function createGenerateBatchHandler(deps: GenerateBatchDeps): JobHandler {
  const now = deps.now ?? (() => new Date());
  const curriculum = createCurriculumRepository(deps.db);
  const verifyEnabled = deps.verify ?? true;

  async function run(ctx: JobContext, requestId: string): Promise<HandlerResult> {
    const { job, ownerId } = ctx;

    const request = await loadRequest(deps.db, { requestId, ownerId, jobId: job.id });
    if (!request) {
      throw new PermanentJobError(
        "request_not_found",
        "Permintaan pembuatan soal tidak ditemukan.",
      );
    }
    const parsed = generationParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new PermanentJobError(
        "invalid_params",
        "Parameter permintaan pembuatan soal tidak valid.",
      );
    }
    const params = parsed.data;
    // Material mode (plan decision 8): the selection is checked again for this owner every time
    // the material is read, so a material trashed or changed since the request gives nothing.
    let selection: MaterialSelection | null = null;
    if (request.mode === "material") {
      const parsedSelection = materialSelectionSchema.safeParse(request.sourceSelection);
      if (!parsedSelection.success) {
        throw new PermanentJobError(
          "invalid_params",
          "Parameter permintaan pembuatan soal tidak valid.",
        );
      }
      selection = parsedSelection.data;
    }
    // The material's passages for a call of `count` questions (`pack` null when nothing is
    // usable; `unrelated` when the pages are readable but none matches the topic) and their tokens.
    const loadMaterial = async (
      topicId: string,
      count: number,
    ): Promise<{ pack: MaterialPack | null; unrelated: boolean; tokens: number }> => {
      if (!selection) return { pack: null, unrelated: false, tokens: 0 };
      const context = await buildMaterialContext(deps.db, {
        ownerId,
        materialId: selection.materialId,
        selection,
        topicId,
        maxTokens: materialContextBudget(count),
      });
      return {
        pack:
          context.passages.length > 0
            ? { materialId: selection.materialId, passages: context.passages }
            : null,
        unrelated: context.unrelated === true,
        tokens: context.tokens,
      };
    };
    // Material text is teacher content (C2): only zero-retention routes (Groq) may receive it,
    // and when their quota is out the job defers (no fallback, decision 9).
    const packFor = (
      topic: TopicDetail,
      material: MaterialPack | null,
    ): GenerateMcParams => {
      const pack = buildContextPack(topic, params);
      return material
        ? {
            ...pack,
            dataClass: "C2",
            passages: material.passages.map((passage) => ({
              id: passage.id,
              text: passage.text,
            })),
          }
        : pack;
    };
    const progress = (step: string, done: number): Progress => ({
      step,
      done,
      total: params.quantity,
    });
    const finish = async (count: number): Promise<HandlerResult> => {
      await setRequestStatus(deps.db, {
        requestId,
        ownerId,
        jobId: job.id,
        status: count >= params.quantity ? "succeeded" : "partial",
        now: now(),
      });
      return { kind: "done", progress: progress("saved", count) };
    };

    // Not enough runner time left (or the model lock is busy): hand the job back to run when the
    // runner budget ends. "continue" would be claimed again at once and spin.
    const waiting = (): HandlerResult => ({
      kind: "defer",
      runAfter: new Date(ctx.deadline),
      progress: progress("waiting", 0),
    });

    // Verifies every saved draft (and regenerates a contradicted one once), then completes the
    // request. `extra` carries what generation already knows (rejected counts, duration).
    const verifyAndFinish = async (
      count: number,
      extra: {
        durationMs?: number;
        rejected?: number;
        findings?: Record<string, number>;
      },
    ): Promise<HandlerResult> => {
      // A resumed verification shows as running again (a no-op unless queued or deferred).
      await setRequestStatus(deps.db, {
        requestId,
        ownerId,
        jobId: job.id,
        status: "running",
        from: ["queued", "deferred"],
        now: now(),
      });
      const outcome = await verifyRequest(
        { db: deps.db, createGateway: deps.createGateway, now },
        {
          ownerId,
          jobId: job.id,
          requestId,
          deadline: ctx.deadline,
          loadContext: async () => {
            const topic = await curriculum.getTopicInVersion(
              params.topicId,
              params.curriculumVersionId,
            );
            if (!topic) return null;
            // A material question is regenerated from the material only; gone means no replacement.
            const material = (await loadMaterial(topic.id, 1)).pack;
            if (selection && !material) return null;
            return {
              topicId: topic.id,
              sourceRef: topic.sourceRef,
              curriculumVersionId: params.curriculumVersionId,
              pack: packFor(topic, material),
              ...(material ? { material } : {}),
            };
          },
          dataClass: selection ? "C2" : "C0",
          requireCitations: selection !== null,
        },
      );
      if (outcome.kind === "defer") {
        const deferred = outcome.reason !== "time";
        if (deferred) {
          await setRequestStatus(deps.db, {
            requestId,
            ownerId,
            jobId: job.id,
            status: "deferred",
            from: ["running", "queued", "deferred"],
            now: now(),
          });
        }
        const messageKey =
          outcome.reason === "provider"
            ? "provider_rate_limited"
            : outcome.reason === "quota_daily" || outcome.reason === "quota_minute"
              ? outcome.reason
              : undefined;
        return {
          kind: "defer",
          runAfter: outcome.runAfter,
          progress: {
            ...progress(deferred ? "deferred" : "waiting", 0),
            ...(messageKey ? { messageKey } : {}),
          },
        };
      }
      const status = count >= params.quantity ? "succeeded" : "partial";
      await setRequestStatus(deps.db, {
        requestId,
        ownerId,
        jobId: job.id,
        status,
        now: now(),
      });
      // A re-run of an already completed request must not count the completion twice.
      const alreadyCompleted =
        request.status === "succeeded" || request.status === "partial";
      if (!alreadyCompleted) {
        const verified: StatusCounts = outcome.counts;
        await recordUsage(deps.db, {
          ownerId,
          event: "generation_completed",
          entityType: "generation_request",
          entityId: requestId,
          durationMs: extra.durationMs,
          metadata: {
            requested: params.quantity,
            returned: count,
            status,
            rejected: extra.rejected ?? 0,
            findings: extra.findings ?? {},
            verified,
            regenerated: outcome.regenerated,
          },
        });
      }
      return { kind: "done", progress: progress("saved", count) };
    };

    if (request.status === "cancelled") {
      return { kind: "done", progress: progress("cancelled", 0) };
    }
    const existing = await countDrafts(deps.db, { requestId, ownerId });
    if (existing > 0) {
      return verifyEnabled ? verifyAndFinish(existing, {}) : finish(existing);
    }

    if (ctx.deadline - now().getTime() < MIN_REMAINING_MS) {
      return waiting();
    }

    await setRequestStatus(deps.db, {
      requestId,
      ownerId,
      jobId: job.id,
      status: "running",
      from: ["queued", "deferred"],
      now: now(),
    });

    const topic = await curriculum.getTopicInVersion(
      params.topicId,
      params.curriculumVersionId,
    );
    if (!topic) {
      throw new PermanentJobError(
        "topic_not_found",
        "Topik untuk permintaan ini tidak ditemukan.",
      );
    }
    const loaded = await loadMaterial(topic.id, params.quantity);
    const material = loaded.pack;
    if (selection && !material) {
      throw loaded.unrelated
        ? new PermanentJobError(
            "material_unrelated",
            "Halaman materi yang dipilih tidak membahas topik ini.",
          )
        : new PermanentJobError(
            "material_unavailable",
            "Materi sumber tidak dapat dipakai.",
          );
    }
    const pack = packFor(topic, material);
    const promptVersion = promptVersionOf(pack);

    const waitMs = lockWaitMs(ctx.deadline, now().getTime());
    let outcome: CallOutcome;
    try {
      outcome = await deps.db.transaction(async (rawTx): Promise<CallOutcome> => {
        const tx = rawTx as unknown as AnyDb;
        // Do not wait for the lock longer than the runner budget allows (lock_not_available, 55P03,
        // is handled below). The value is an integer computed here, never user input.
        await tx.execute(sql.raw(`set local lock_timeout = '${String(waitMs)}ms'`));
        // Serialises every call to this model across runners. The budget below is read after the
        // previous holder's commit, so it includes that holder's spend. Relies on READ COMMITTED.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`ai:${GENERATE_QUOTA.model}`}, 0))`,
        );
        await tx.execute(sql.raw("set local lock_timeout = 0"));

        // Another run (or a run whose lease expired) may have saved the drafts while this one waited.
        const saved = await countDrafts(tx, { requestId, ownerId });
        if (saved > 0) return { kind: "already_saved", count: saved };

        // Waiting for the lock can take a while, so the time left is checked again before a call that
        // may last about a minute; the next step starts again from a fresh runner budget.
        if (ctx.deadline - now().getTime() < MIN_REMAINING_MS) return { kind: "wait" };

        const spends = await readRecentSpends(tx, GENERATE_QUOTA.model, now());
        const plan = planQuota({
          spends,
          estimate: estimateBatchTokens(params.quantity) + loaded.tokens,
          perDay: GENERATE_QUOTA.perDay,
          now: now(),
        });
        if (!plan.ok) {
          return {
            kind: "deferred",
            resumeAt: plan.error.resumeAt,
            messageKey: "quota_daily",
          };
        }

        const spent: AiUsage = { inputTokens: 0, outputTokens: 0 };
        const startedAt = now().getTime();
        let result;
        try {
          result = await generateMultipleChoiceBatch(
            deps.createGateway(createGenerationBudget(spends, () => now().getTime())),
            pack,
            {
              maxOutputTokens: params.quantity * OUTPUT_TOKENS_PER_QUESTION,
              onUsage: (usage) => {
                spent.inputTokens += usage.inputTokens;
                spent.outputTokens += usage.outputTokens;
                if (usage.cachedTokens !== undefined) {
                  spent.cachedTokens = (spent.cachedTokens ?? 0) + usage.cachedTokens;
                }
              },
            },
          );
        } catch (error) {
          // A refusal after a paid attempt means the repair did not fit the per-minute budget. The
          // job may be deferred for that once; a second time it fails the attempt instead of
          // regenerating from scratch again and again on the shared quota.
          const paid = spent.inputTokens + spent.outputTokens > 0;
          // A provider 429 is a wait, not a failure: defer without using an attempt, but only a
          // bounded number of times per job.
          if (error instanceof AiProviderError && error.kind === "rate_limited") {
            const earlier = await countProviderDeferrals(tx, { ownerId, jobId: job.id });
            const capped = earlier >= MAX_PROVIDER_DEFERRALS;
            await insertAiCall(tx, {
              ownerId,
              jobId: job.id,
              provider: PRIMARY_ROUTE.provider,
              model: PRIMARY_ROUTE.model,
              promptVersion,
              usage: spent,
              latencyMs: now().getTime() - startedAt,
              outcome: "error",
              errorCode: capped ? "provider_busy" : "provider_rate_limited",
              createdAt: now(),
            });
            if (capped) return { kind: "failed", error };
            return {
              kind: "provider_limited",
              resumeAt: new Date(
                now().getTime() + providerRetryDelayMs(error.retryAfterMs),
              ),
            };
          }
          let failure = error;
          let errorCode = errorCodeOf(error);
          if (error instanceof AiQuotaError && paid) {
            const earlier = await countRepairDeferrals(tx, { ownerId, jobId: job.id });
            if (earlier > 0) {
              failure = new AiOutputError("Keluaran AI tidak valid setelah perbaikan.");
              errorCode = errorCodeOf(failure);
            } else {
              errorCode = "repair_deferred";
            }
          }
          // Record the attempt and commit it before the error leaves the transaction, so the tokens
          // that were spent still count against the budget.
          await insertAiCall(tx, {
            ownerId,
            jobId: job.id,
            provider: PRIMARY_ROUTE.provider,
            model: PRIMARY_ROUTE.model,
            promptVersion,
            usage: spent,
            latencyMs: now().getTime() - startedAt,
            outcome: "error",
            errorCode,
            createdAt: now(),
          });
          if (failure instanceof AiQuotaError) {
            const fresh = await readRecentSpends(tx, GENERATE_QUOTA.model, now());
            const again = planQuota({
              spends: fresh,
              estimate: estimateBatchTokens(params.quantity) + loaded.tokens,
              perDay: GENERATE_QUOTA.perDay,
              now: now(),
            });
            return {
              kind: "quota",
              resumeAt: again.ok
                ? new Date(now().getTime() + QUOTA_RETRY_MS)
                : again.error.resumeAt,
              messageKey: again.ok ? "quota_minute" : "quota_daily",
            };
          }
          return { kind: "failed", error: failure };
        }

        const latencyMs = now().getTime() - startedAt;
        // Every returned question is checked; the first `quantity` that pass are kept, so a valid
        // surplus question can fill the place of a rejected one. Rejected questions are not saved.
        const checked = result.value.questions.map((question) => ({
          question,
          findings: checkMultipleChoice(question),
        }));
        const rejectedChecks = checked.filter((item) => item.findings.length > 0);
        const findingCounts = countFindings(
          rejectedChecks.flatMap((item) => item.findings),
        );
        const drafts = checked
          .filter((item) => item.findings.length === 0)
          .slice(0, params.quantity)
          // The model puts the key first almost every time. Shuffled here, after the structural
          // checks and before anything is saved, because versions are immutable and verification
          // reads the saved version. Seeded by request and position, so a retry gives the same order.
          .map((item, index) =>
            shuffleQuestionOptions(
              item.question,
              hashSeed(`${requestId}:${String(index)}`),
            ),
          );
        if (drafts.length === 0) {
          // The call succeeded and cost tokens, but nothing is usable: record the spend as an error
          // row (no drafts, no generation run) and let the runner retry.
          await insertAiCall(tx, {
            ownerId,
            jobId: job.id,
            provider: result.provider,
            model: result.model,
            promptVersion,
            usage: spent,
            latencyMs,
            outcome: "error",
            errorCode: "structural_failed",
            createdAt: now(),
          });
          return {
            kind: "failed",
            error: new StructuralFailedError(rejectedChecks.length, findingCounts),
          };
        }
        // Material mode: each kept question's citations, checked against the passages it was given.
        // A question citing anything else is saved without them and regenerated once later.
        const materialSources = material
          ? drafts.map((draft) => {
              const citations = validateCitations(
                draft,
                material.passages.map((passage) => passage.id),
              );
              return citations.ok ? citationSources(material, citations.data) : null;
            })
          : undefined;
        // The drafts are written in a savepoint: if they cannot be saved, only they roll back and the
        // tokens already spent are still recorded below.
        try {
          await tx.transaction(async (savepoint) => {
            await persistDrafts(savepoint, {
              ownerId,
              requestId,
              topicId: topic.id,
              sourceRef: topic.sourceRef,
              grade: params.grade,
              difficulty: params.difficulty,
              run: {
                provider: result.provider,
                model: result.model,
                promptVersion,
                curriculumVersionId: params.curriculumVersionId,
                usage: spent,
                latencyMs,
              },
              questions: drafts,
              ...(materialSources ? { materialSources } : {}),
              now: now(),
            });
          });
        } catch {
          await insertAiCall(tx, {
            ownerId,
            jobId: job.id,
            provider: result.provider,
            model: result.model,
            promptVersion,
            usage: spent,
            latencyMs,
            outcome: "error",
            errorCode: "persist_failed",
            createdAt: now(),
          });
          return { kind: "failed", error: new PersistFailedError() };
        }
        await insertAiCall(tx, {
          ownerId,
          jobId: job.id,
          provider: result.provider,
          model: result.model,
          promptVersion,
          usage: spent,
          latencyMs,
          outcome: "ok",
          createdAt: now(),
        });
        return {
          kind: "saved",
          count: drafts.length,
          durationMs: latencyMs,
          rejected: rejectedChecks.length,
          findings: findingCounts,
        };
      });
    } catch (error) {
      if (pgCodeOf(error) !== "55P03") throw error;
      outcome = { kind: "wait" };
    }

    switch (outcome.kind) {
      case "already_saved":
        return verifyEnabled ? verifyAndFinish(outcome.count, {}) : finish(outcome.count);
      case "wait":
        return waiting();
      case "deferred":
      case "quota":
      case "provider_limited": {
        await setRequestStatus(deps.db, {
          requestId,
          ownerId,
          jobId: job.id,
          status: "deferred",
          from: ["running", "queued", "deferred"],
          now: now(),
        });
        const messageKey =
          outcome.kind === "provider_limited"
            ? "provider_rate_limited"
            : outcome.messageKey;
        return {
          kind: "defer",
          runAfter: outcome.resumeAt,
          progress: { ...progress("deferred", 0), messageKey },
        };
      }
      case "saved": {
        // The drafts are committed: audit them once (the existing-drafts re-run paths never reach here).
        await recordAudit(deps.db, {
          ownerId,
          action: AUDIT_DRAFTS_GENERATED,
          entityType: "generation_request",
          entityId: requestId,
          metadata: { returned: outcome.count, rejected: outcome.rejected },
        });
        if (verifyEnabled) {
          // Counts only, at save time: the completion event comes once, after verification.
          await recordUsage(deps.db, {
            ownerId,
            event: "generation_drafts_saved",
            entityType: "generation_request",
            entityId: requestId,
            durationMs: outcome.durationMs,
            metadata: {
              requested: params.quantity,
              returned: outcome.count,
              rejected: outcome.rejected,
              findings: outcome.findings,
            },
          });
          return verifyAndFinish(outcome.count, {
            durationMs: outcome.durationMs,
            rejected: outcome.rejected,
            findings: outcome.findings,
          });
        }
        const status = outcome.count >= params.quantity ? "succeeded" : "partial";
        await setRequestStatus(deps.db, {
          requestId,
          ownerId,
          jobId: job.id,
          status,
          now: now(),
        });
        await recordUsage(deps.db, {
          ownerId,
          event: "generation_completed",
          entityType: "generation_request",
          entityId: requestId,
          durationMs: outcome.durationMs,
          metadata: {
            requested: params.quantity,
            returned: outcome.count,
            status,
            rejected: outcome.rejected,
            findings: outcome.findings,
          },
        });
        return { kind: "done", progress: progress("saved", outcome.count) };
      }
      case "failed": {
        if (outcome.error instanceof StructuralFailedError) throw outcome.error;
        if (outcome.error instanceof AiPolicyError) {
          throw new PermanentJobError(outcome.error.code, outcome.error.message);
        }
        // Provider and database messages are not shown or stored; the details are in ai_calls.
        if (outcome.error instanceof AiOutputError) {
          throw new RetryableJobError(
            "invalid_output",
            "Keluaran AI tidak valid setelah perbaikan.",
          );
        }
        if (outcome.error instanceof PersistFailedError) {
          throw new RetryableJobError(
            "persist_failed",
            "Draf soal tidak dapat disimpan.",
          );
        }
        if (
          outcome.error instanceof AiProviderError &&
          outcome.error.kind === "rate_limited"
        ) {
          throw new RetryableJobError(
            "provider_busy",
            "Layanan AI masih membatasi permintaan.",
          );
        }
        // A rejected key will be rejected again: fail now so the teacher is not left waiting on retries.
        if (
          outcome.error instanceof AiProviderError &&
          outcome.error.kind === "auth_failed"
        ) {
          throw new PermanentJobError(
            "provider_misconfigured",
            "Layanan AI belum diatur dengan benar.",
          );
        }
        throw new RetryableJobError(
          "provider_unavailable",
          "Layanan AI sedang tidak dapat dijangkau.",
        );
      }
    }
  }

  return async (ctx) => {
    const payload = payloadSchema.safeParse(ctx.job.payload);
    if (!payload.success) {
      throw new PermanentJobError(
        "request_not_found",
        "Permintaan pembuatan soal tidak ditemukan.",
      );
    }
    const requestId = payload.data.requestId;
    const lastAttempt = ctx.job.attempts + 1 >= ctx.job.maxAttempts;
    try {
      return await run(ctx, requestId);
    } catch (error) {
      // A payload that names no request of this job's own is not ours to mark as failed.
      const notOurs =
        error instanceof PermanentJobError && error.code === "request_not_found";
      if (!notOurs && (error instanceof PermanentJobError || lastAttempt)) {
        // Best effort: the runner records the job failure itself; this keeps the request in step.
        try {
          await setRequestStatus(deps.db, {
            requestId,
            ownerId: ctx.ownerId,
            jobId: ctx.job.id,
            status: "failed",
            from: ["queued", "running", "deferred"],
            now: now(),
          });
          await recordUsage(deps.db, {
            ownerId: ctx.ownerId,
            event: "generation_failed",
            entityType: "generation_request",
            entityId: requestId,
            metadata:
              error instanceof StructuralFailedError
                ? {
                    code: "structural_failed",
                    rejected: error.rejected,
                    findings: error.findings,
                  }
                : {
                    code:
                      error instanceof PermanentJobError ||
                      error instanceof RetryableJobError
                        ? error.code
                        : "system_error",
                  },
          });
        } catch {
          // Ignored: never hide the original error.
        }
      }
      if (error instanceof PermanentJobError || error instanceof RetryableJobError)
        throw error;
      // Never the message or parameters: a database error can carry both.
      logger.error(
        { module: "generation", code: pgCodeOf(error) },
        "generate_batch: step failed",
      );
      throw new RetryableJobError(
        "system_error",
        "Pembuatan soal gagal karena kesalahan sistem.",
      );
    }
  };
}
