import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  AiProviderError,
  AiQuotaError,
  defaultRouting,
  type AiUsage,
  type DataClass,
  type TokenBudget,
} from "@/lib/ai";
import { recordAudit } from "@/lib/events/recorders";
import {
  CROSS_CHECK_DISAGREES,
  crossCheckVerdict,
  decideStatus,
  evaluateClaim,
  VERIFIER_VERSION,
  type CrossCheckVerdict,
  type QuestionStatus,
} from "@/features/verification";
import { AUDIT_QUESTION_REGENERATED } from "./audit";
import { generateMultipleChoiceBatch } from "./generate-mc";
import { countProviderDeferrals, insertAiCall, type AnyDb } from "./persist";
import {
  clampCorrectionNote,
  promptVersionOf,
  type GenerateMcParams,
} from "./prompts/generate-mc.id";
import { validateCitations } from "./citations";
import { estimateTokens } from "./material-context";
import {
  CITATION_FAILURE_CHECK,
  MATERIAL_GONE_CHECK,
  citationSources,
  hasCitationFailure,
  type MaterialPack,
  type MaterialSourceRow,
} from "./material-sources";
import { SOLVE_INDEPENDENT_PROMPT_VERSION } from "./prompts/solve-independent.id";
import {
  createGenerationBudget,
  createModelBudget,
  CROSS_CHECK_ESTIMATE_TOKENS,
  CROSS_CHECK_MAX_OUTPUT_TOKENS,
  estimateBatchTokens,
  GENERATE_QUOTA,
  planQuota,
  readRecentSpends,
  SOLVE_QUOTA,
} from "./quota";
import { claimSchema } from "../schema/schemas";
import { hashSeed } from "./seeded-shuffle";
import { shuffleQuestionOptions } from "./shuffle-options";
import { solveIndependent } from "./solve-independent";
import {
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
import {
  insertRegenerationMarker,
  insertVerificationRun,
  listCurrentVersions,
  persistRegeneratedVersion,
  type CurrentVersion,
} from "./verify-persist";

const SOLVE_ROUTE = defaultRouting.solve_independent[0];
const GENERATE_ROUTE = defaultRouting.generate_questions[0];

export interface VerifyDeps {
  db: AnyDb;
  createGateway: (budget: TokenBudget) => Gateway;
  now: () => Date;
}

export interface VerifyContext {
  topicId: string;
  sourceRef: string;
  curriculumVersionId: string;
  pack: GenerateMcParams;
  // Material mode: the material and the passages `pack` carries; a replacement must cite them.
  material?: MaterialPack;
}

export interface VerifyInput {
  ownerId: string;
  jobId: string;
  requestId: string;
  // Epoch ms at which the runner's budget ends.
  deadline: number;
  // Only a regeneration needs the topic and the context pack, so they are read on demand.
  loadContext: () => Promise<VerifyContext | null>;
  // The data class of the questions sent to the cross-check: C2 for questions written from a
  // teacher's material (only zero-retention routes), C0 otherwise.
  dataClass?: DataClass;
  // Material mode: a version without material citations had them rejected (see verifyVersion).
  requireCitations?: boolean;
}

export type StatusCounts = Record<QuestionStatus, number>;

export type VerifyOutcome =
  | { kind: "done"; counts: StatusCounts; regenerated: number }
  | {
      kind: "defer";
      runAfter: Date;
      reason: "time" | "quota_daily" | "quota_minute" | "provider";
    };

type UnitOutcome =
  | { kind: "progress" }
  | {
      kind: "defer";
      runAfter: Date;
      reason: "time" | "quota_daily" | "quota_minute" | "provider";
    };

const checksSchema = z.array(
  z.object({ type: z.string(), status: z.string(), detail: z.string() }),
);

// The one-line reason a version was contradicted, rebuilt from its stored run so a resumed job
// gives the same hint as the run that found the contradiction.
export function correctionNoteFrom(run: {
  checks: unknown;
  crossCheck: unknown;
}): string {
  const parsed = checksSchema.safeParse(run.checks);
  const failed = parsed.success
    ? parsed.data.filter((check) => check.status === "fail").map((check) => check.detail)
    : [];
  return clampCorrectionNote(failed[0] ?? CROSS_CHECK_DISAGREES);
}

export type RegenerationReason =
  "claim_failed" | "cross_check_disagreed" | "citation_invalid";

// Why the version was regenerated, rebuilt from its stored run: rejected citations, a failing
// claim, otherwise the solver disagreeing.
export function regenerationReasonFrom(run: { checks: unknown }): RegenerationReason {
  if (hasCitationFailure(run)) return "citation_invalid";
  const parsed = checksSchema.safeParse(run.checks);
  const failed = parsed.success && parsed.data.some((check) => check.status === "fail");
  return failed ? "claim_failed" : "cross_check_disagreed";
}

function emptyCounts(): StatusCounts {
  return {
    terverifikasi: 0,
    dicek_silang: 0,
    belum_dapat_diverifikasi: 0,
    ketidaksesuaian: 0,
  };
}

// A first version is regenerated once when it was contradicted or its material citations were
// rejected (a material question with an invented passage id).
function needsWork(version: CurrentVersion): boolean {
  if (version.run === null) return true;
  return (
    (version.run.status === "ketidaksesuaian" || hasCitationFailure(version.run)) &&
    version.versionNo === 1 &&
    !version.regenerationRecorded
  );
}

function optionTexts(version: CurrentVersion): [string, string, string, string] {
  const byLabel = new Map(
    version.options.map((option) => [option.label, option.text_md]),
  );
  return ["A", "B", "C", "D"].map((label) => byLabel.get(label) ?? "") as [
    string,
    string,
    string,
    string,
  ];
}

function clampText(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Verifies every current version of a request, one step at a time: deterministic claims, an
 * independent cross-check, and one regeneration of a contradicted first version. Pending
 * cross-checks run before regenerations (different model budgets). Resumable from stored runs.
 */
export async function verifyRequest(
  deps: VerifyDeps,
  input: VerifyInput,
): Promise<VerifyOutcome> {
  for (;;) {
    const versions = await listCurrentVersions(deps.db, {
      requestId: input.requestId,
      ownerId: input.ownerId,
    });
    // Pending cross-checks first: they draw on the solver model's budget, a regeneration on the
    // generation model's, so a regeneration waiting for budget must not hold them back. Version 2
    // is created without a run, so it is still verified before the job finishes.
    const next = versions.find((v) => v.run === null) ?? versions.find(needsWork);
    if (!next) {
      const counts = emptyCounts();
      for (const version of versions) {
        const status = version.status as QuestionStatus;
        if (status in counts) counts[status] += 1;
      }
      return {
        kind: "done",
        counts,
        regenerated: versions.filter((version) => version.versionNo >= 2).length,
      };
    }

    // Each unit may be a model call of about a minute: not with the runner budget nearly gone.
    if (input.deadline - deps.now().getTime() < MIN_REMAINING_MS) {
      return { kind: "defer", runAfter: new Date(input.deadline), reason: "time" };
    }

    const unit =
      next.run === null
        ? await verifyVersion(
            deps,
            {
              ownerId: input.ownerId,
              jobId: input.jobId,
              deadline: input.deadline,
              dataClass: input.dataClass,
              requireCitations: input.requireCitations,
              reload: async (tx) =>
                (
                  await listCurrentVersions(tx, {
                    requestId: input.requestId,
                    ownerId: input.ownerId,
                  })
                ).find((candidate) => candidate.versionId === next.versionId),
            },
            next,
          )
        : await regenerateQuestion(deps, input, next);
    if (unit.kind === "defer") return unit;
  }
}

// ── cross-check ────────────────────────────────────────────────────────────────────────────

export interface VerifyVersionInput {
  ownerId: string;
  jobId: string;
  // Epoch ms at which the runner's budget ends.
  deadline: number;
  // The version as stored now (read again under the model lock); undefined when it is gone.
  reload: (tx: AnyDb) => Promise<CurrentVersion | undefined>;
  // C0 unless the question was written from a teacher's material (C2).
  dataClass?: DataClass;
  // The version must cite the material: one without material sources had its citations
  // rejected. Its claims and cross-check still run; the citation failure is one more failed
  // check and caps the status at `belum_dapat_diverifikasi` (a contradiction stays one).
  requireCitations?: boolean;
}

/**
 * Deterministic claims plus the independent cross-check of one version, written as a verification
 * run. Defers on the solver budget or a provider limit; a version that already has a run is left
 * alone.
 */
export async function verifyVersion(
  deps: VerifyDeps,
  input: VerifyVersionInput,
  version: CurrentVersion,
): Promise<UnitOutcome> {
  const now = deps.now;
  const { ownerId, jobId } = input;
  const parsedClaims = z.array(claimSchema).safeParse(version.claims);
  const claimResults = (parsedClaims.success ? parsedClaims.data : []).map(evaluateClaim);
  const waitMs = lockWaitMs(input.deadline, now().getTime());

  type Tx =
    | { kind: "verified" }
    | { kind: "already" }
    | { kind: "wait" }
    | { kind: "quota"; resumeAt: Date; reason: "quota_daily" | "quota_minute" }
    | { kind: "provider"; resumeAt: Date };

  let outcome: Tx;
  try {
    outcome = await deps.db.transaction(async (rawTx): Promise<Tx> => {
      const tx = rawTx as unknown as AnyDb;
      await tx.execute(sql.raw(`set local lock_timeout = '${String(waitMs)}ms'`));
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`ai:${SOLVE_QUOTA.model}`}, 0))`,
      );
      await tx.execute(sql.raw("set local lock_timeout = 0"));

      // Another run may have verified this version while this one waited for the lock.
      const fresh = await input.reload(tx);
      if (fresh?.versionId !== version.versionId || fresh.run !== null) {
        return { kind: "already" };
      }

      if (input.deadline - now().getTime() < MIN_REMAINING_MS) return { kind: "wait" };

      const spends = await readRecentSpends(tx, SOLVE_QUOTA.model, now());
      const plan = planQuota({
        spends,
        estimate: CROSS_CHECK_ESTIMATE_TOKENS,
        perDay: SOLVE_QUOTA.perDay,
        now: now(),
      });
      if (!plan.ok) {
        return { kind: "quota", resumeAt: plan.error.resumeAt, reason: "quota_daily" };
      }

      const spent: AiUsage = { inputTokens: 0, outputTokens: 0 };
      const startedAt = now().getTime();
      let verdict: CrossCheckVerdict = "unknown";
      let crossCheck: Record<string, unknown> = {
        provider: SOLVE_ROUTE.provider,
        model: SOLVE_ROUTE.model,
        verdict: "unknown",
      };
      let solved: { provider: string; model: string } | null = null;
      try {
        const result = await solveIndependent(
          deps.createGateway(
            createModelBudget(SOLVE_QUOTA.model, spends, () => now().getTime()),
          ),
          {
            questionStemMd: version.stemMd,
            optionTexts_md: optionTexts(version),
            dataClass: input.dataClass ?? "C0",
          },
          {
            maxOutputTokens: CROSS_CHECK_MAX_OUTPUT_TOKENS,
            onUsage: (usage) => {
              spent.inputTokens += usage.inputTokens;
              spent.outputTokens += usage.outputTokens;
              if (usage.cachedTokens !== undefined) {
                spent.cachedTokens = (spent.cachedTokens ?? 0) + usage.cachedTokens;
              }
            },
          },
        );
        verdict = crossCheckVerdict({
          solverLabel: result.value.correctLabel,
          solverMachine: result.value.answer.machine,
          questionLabel: version.answer.correctLabel,
          questionMachine: version.answer.machine,
        });
        crossCheck = {
          provider: result.provider,
          model: result.model,
          verdict,
          correctLabel: result.value.correctLabel,
          machine: clampText(result.value.answer.machine, 100),
        };
        solved = { provider: result.provider, model: result.model };
      } catch (error) {
        const paid = spent.inputTokens + spent.outputTokens > 0;
        // A provider 429 is a wait: defer (bounded per job) instead of recording "no signal" at the
        // first throttle. Past the cap the usual no-signal rule applies.
        if (error instanceof AiProviderError && error.kind === "rate_limited") {
          const earlier = await countProviderDeferrals(tx, { ownerId, jobId });
          const capped = earlier >= MAX_PROVIDER_DEFERRALS;
          await insertAiCall(tx, {
            ownerId,
            jobId,
            task: "solve_independent",
            provider: SOLVE_ROUTE.provider,
            model: SOLVE_ROUTE.model,
            promptVersion: SOLVE_INDEPENDENT_PROMPT_VERSION,
            usage: spent,
            latencyMs: now().getTime() - startedAt,
            outcome: "error",
            errorCode: capped ? "provider_busy" : "provider_rate_limited",
            createdAt: now(),
          });
          if (!capped) {
            return {
              kind: "provider",
              resumeAt: new Date(
                now().getTime() + providerRetryDelayMs(error.retryAfterMs),
              ),
            };
          }
          crossCheck = { ...crossCheck, reason: "unavailable" };
          // falls through to the status decision below (the row above is the only ai_calls row)
        } else {
          await insertAiCall(tx, {
            ownerId,
            jobId,
            task: "solve_independent",
            provider: SOLVE_ROUTE.provider,
            model: SOLVE_ROUTE.model,
            promptVersion: SOLVE_INDEPENDENT_PROMPT_VERSION,
            usage: spent,
            latencyMs: now().getTime() - startedAt,
            outcome: "error",
            errorCode:
              error instanceof AiQuotaError ? "quota_deferred" : "cross_check_failed",
            createdAt: now(),
          });
          // Nothing was affordable yet: wait for the budget. Anything else (a paid call whose repair
          // was refused, a provider error, unusable output) is "no signal", never a retry loop.
          if (error instanceof AiQuotaError && !paid) {
            return {
              kind: "quota",
              resumeAt: new Date(now().getTime() + QUOTA_RETRY_MS),
              reason: "quota_minute",
            };
          }
          crossCheck = { ...crossCheck, reason: "unavailable" };
        }
      }
      // Recorded outside the solver try/catch: a failed insert here is not a solver failure.
      if (solved) {
        await insertAiCall(tx, {
          ownerId,
          jobId,
          task: "solve_independent",
          provider: solved.provider,
          model: solved.model,
          promptVersion: SOLVE_INDEPENDENT_PROMPT_VERSION,
          usage: spent,
          latencyMs: now().getTime() - startedAt,
          outcome: "ok",
          createdAt: now(),
        });
      }

      const decision = decideStatus(claimResults, verdict);
      const citationsRejected =
        input.requireCitations === true && version.materialSources === 0;
      // The worse of the two: a contradiction stays one; anything better is unverifiable.
      const status: QuestionStatus =
        citationsRejected && decision.status !== "ketidaksesuaian"
          ? "belum_dapat_diverifikasi"
          : decision.status;
      // question_versions is immutable: this row is the status write.
      await insertVerificationRun(tx, {
        ownerId,
        versionId: version.versionId,
        verifierVersion: VERIFIER_VERSION,
        status,
        checks: [
          ...claimResults.map((result) => ({
            type: result.claim.type,
            status: result.status,
            detail: result.detail,
          })),
          ...(citationsRejected
            ? [version.materialGone ? MATERIAL_GONE_CHECK : CITATION_FAILURE_CHECK]
            : []),
        ],
        crossCheck,
        now: now(),
      });
      return { kind: "verified" };
    });
  } catch (error) {
    if (pgCodeOf(error) !== "55P03") throw error;
    outcome = { kind: "wait" };
  }

  if (outcome.kind === "wait") {
    return { kind: "defer", runAfter: new Date(input.deadline), reason: "time" };
  }
  if (outcome.kind === "quota") {
    return { kind: "defer", runAfter: outcome.resumeAt, reason: outcome.reason };
  }
  if (outcome.kind === "provider") {
    return { kind: "defer", runAfter: outcome.resumeAt, reason: "provider" };
  }
  return { kind: "progress" };
}

// ── regeneration ───────────────────────────────────────────────────────────────────────────

async function regenerateQuestion(
  deps: VerifyDeps,
  input: VerifyInput,
  version: CurrentVersion,
): Promise<UnitOutcome> {
  const now = deps.now;
  const { ownerId, jobId } = input;
  // Only a version with a contradicting run is regenerated (see needsWork).
  const run = version.run;
  if (run === null) throw new Error("regenerateQuestion needs a verification run");
  const context = await input.loadContext();
  const note = correctionNoteFrom(run);
  const promptVersion = context ? promptVersionOf(context.pack) : "";
  const waitMs = lockWaitMs(input.deadline, now().getTime());

  type Tx =
    | { kind: "done" }
    | { kind: "created" }
    | { kind: "wait" }
    | { kind: "quota"; resumeAt: Date; reason: "quota_daily" | "quota_minute" }
    | { kind: "provider"; resumeAt: Date };

  let outcome: Tx;
  try {
    outcome = await deps.db.transaction(async (rawTx): Promise<Tx> => {
      const tx = rawTx as unknown as AnyDb;

      // The topic is gone: nothing to regenerate from. Recorded so it is not tried again.
      if (!context) {
        await insertRegenerationMarker(tx, {
          ownerId,
          versionId: version.versionId,
          now: now(),
        });
        return { kind: "done" };
      }

      await tx.execute(sql.raw(`set local lock_timeout = '${String(waitMs)}ms'`));
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`ai:${GENERATE_QUOTA.model}`}, 0))`,
      );
      await tx.execute(sql.raw("set local lock_timeout = 0"));

      const fresh = (
        await listCurrentVersions(tx, { requestId: input.requestId, ownerId })
      ).find((candidate) => candidate.questionId === version.questionId);
      if (!fresh || !needsWork(fresh) || fresh.versionNo !== 1) return { kind: "done" };

      if (input.deadline - now().getTime() < MIN_REMAINING_MS) return { kind: "wait" };

      const spends = await readRecentSpends(tx, GENERATE_QUOTA.model, now());
      const plan = planQuota({
        spends,
        // A material replacement also carries its passages.
        estimate:
          estimateBatchTokens(1) +
          (context.material
            ? context.material.passages.reduce(
                (sum, passage) => sum + estimateTokens(passage.text),
                0,
              )
            : 0),
        perDay: GENERATE_QUOTA.perDay,
        now: now(),
      });
      if (!plan.ok) {
        return { kind: "quota", resumeAt: plan.error.resumeAt, reason: "quota_daily" };
      }

      const spent: AiUsage = { inputTokens: 0, outputTokens: 0 };
      const startedAt = now().getTime();
      const record = (
        outcomeKind: "ok" | "error",
        errorCode?: string,
        provider = GENERATE_ROUTE.provider,
        model = GENERATE_ROUTE.model,
      ) =>
        insertAiCall(tx, {
          ownerId,
          jobId,
          provider,
          model,
          promptVersion,
          usage: spent,
          latencyMs: now().getTime() - startedAt,
          outcome: outcomeKind,
          errorCode,
          createdAt: now(),
        });

      let result;
      try {
        result = await generateMultipleChoiceBatch(
          deps.createGateway(createGenerationBudget(spends, () => now().getTime())),
          { ...context.pack, count: 1, correctionNote: note },
          {
            maxOutputTokens: OUTPUT_TOKENS_PER_QUESTION,
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
        const paid = spent.inputTokens + spent.outputTokens > 0;
        if (error instanceof AiProviderError && error.kind === "rate_limited") {
          // A wait, not a failure: defer (bounded per job) with no marker so the resume regenerates.
          // Past the cap the usual marker-and-done path below applies (the row is recorded once).
          const earlier = await countProviderDeferrals(tx, { ownerId, jobId });
          const capped = earlier >= MAX_PROVIDER_DEFERRALS;
          await record("error", capped ? "provider_busy" : "provider_rate_limited");
          if (!capped) {
            return {
              kind: "provider",
              resumeAt: new Date(
                now().getTime() + providerRetryDelayMs(error.retryAfterMs),
              ),
            };
          }
        } else {
          await record(
            "error",
            error instanceof AiQuotaError ? "quota_deferred" : "regeneration_failed",
          );
          if (error instanceof AiQuotaError && !paid) {
            return {
              kind: "quota",
              resumeAt: new Date(now().getTime() + QUOTA_RETRY_MS),
              reason: "quota_minute",
            };
          }
        }
        await insertRegenerationMarker(tx, {
          ownerId,
          versionId: version.versionId,
          now: now(),
        });
        return { kind: "done" };
      }

      // The first replacement that passes the structural checks (a batch may carry a surplus).
      const replacement = result.value.questions.find(
        (candidate) => checkMultipleChoice(candidate).length === 0,
      );
      // Shuffled like the first version (generate-batch.ts), before it is saved.
      const question = replacement
        ? shuffleQuestionOptions(
            replacement,
            hashSeed(`${input.requestId}:regen:${version.questionId}`),
          )
        : undefined;
      // A material question's replacement must cite passages it was given; one that does not is
      // not used (the version it would replace stays, unverifiable: regenerated once only).
      let materialSources: MaterialSourceRow[] | undefined;
      if (question && context.material) {
        const citations = validateCitations(
          question,
          context.material.passages.map((passage) => passage.id),
        );
        if (citations.ok)
          materialSources = citationSources(context.material, citations.data);
      }
      if (!question || (context.material && !materialSources)) {
        // The call succeeded and cost tokens, but the replacement is not usable.
        await record("ok", undefined, result.provider, result.model);
        await insertRegenerationMarker(tx, {
          ownerId,
          versionId: version.versionId,
          now: now(),
        });
        return { kind: "done" };
      }

      try {
        await tx.transaction(async (savepoint) => {
          await persistRegeneratedVersion(savepoint, {
            ownerId,
            requestId: input.requestId,
            questionId: version.questionId,
            topicId: context.topicId,
            sourceRef: context.sourceRef,
            run: {
              provider: result.provider,
              model: result.model,
              promptVersion,
              curriculumVersionId: context.curriculumVersionId,
              usage: spent,
              latencyMs: now().getTime() - startedAt,
            },
            question,
            difficulty: context.pack.difficulty,
            now: now(),
            ...(materialSources ? { materialSources } : {}),
          });
        });
      } catch {
        await record("error", "persist_failed", result.provider, result.model);
        await insertRegenerationMarker(tx, {
          ownerId,
          versionId: version.versionId,
          now: now(),
        });
        return { kind: "done" };
      }
      await record("ok", undefined, result.provider, result.model);
      return { kind: "created" };
    });
  } catch (error) {
    if (pgCodeOf(error) !== "55P03") throw error;
    outcome = { kind: "wait" };
  }

  if (outcome.kind === "wait") {
    return { kind: "defer", runAfter: new Date(input.deadline), reason: "time" };
  }
  if (outcome.kind === "quota") {
    return { kind: "defer", runAfter: outcome.resumeAt, reason: outcome.reason };
  }
  if (outcome.kind === "provider") {
    return { kind: "defer", runAfter: outcome.resumeAt, reason: "provider" };
  }
  if (outcome.kind === "created") {
    // Version 2 is committed: audit it (best effort, never duplicated by a resume, which sees it).
    await recordAudit(deps.db, {
      ownerId,
      action: AUDIT_QUESTION_REGENERATED,
      entityType: "question",
      entityId: version.questionId,
      metadata: { versionNo: 2, reason: regenerationReasonFrom(run) },
    });
  }
  return { kind: "progress" };
}
