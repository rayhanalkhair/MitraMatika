import { and, count, eq, gt, gte, inArray, like, or, sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import { TokenBudget } from "@/lib/ai/budget";
import { defaultRouting } from "@/lib/ai/routing.config";
import { aiCalls, generationRequests, jobs } from "@/lib/db/schema";
import { err, ok, type Result } from "@/lib/result";
import { REGENERATE_JOB_TYPE } from "../schema/regenerate-input";

const DAY_MS = 86_400_000;

// A 5-question batch costs about 8 000 tokens (2K prompt + 3.5K output + 2.5K cross-check,
// implementation plan §5.12), so 1 600 per question.
export const TOKENS_PER_QUESTION = 1_600;

// The Groq free-tier limits per model (docs/research/free-tier-dependencies.md); the per-minute value
// is the one the Phase 0 smoke and eval runners already use.
export const GENERATE_QUOTA = {
  model: defaultRouting.generate_questions[0].model,
  perMinute: 8_000,
  perDay: 200_000,
} as const;

// The cross-check model has its own free-tier bucket with the same limits
// (docs/research/free-tier-dependencies.md §1).
export const SOLVE_QUOTA = {
  model: defaultRouting.solve_independent[0].model,
  perMinute: 8_000,
  perDay: 200_000,
} as const;

// About 2K tokens per cross-check call (implementation plan §5.12); the daily plan uses this and the
// gateway's own per-minute check uses the real prompt plus CROSS_CHECK_MAX_OUTPUT_TOKENS.
export const CROSS_CHECK_ESTIMATE_TOKENS = 2_500;
export const CROSS_CHECK_MAX_OUTPUT_TOKENS = 1_200;

// How many questions one user may request per Asia/Jakarta calendar day, whatever the global Groq
// budget allows. The compensating control for open sign-up (plan decision 8).
export const USER_DAILY_QUESTION_LIMIT = 30;

// Asia/Jakarta is UTC+7 all year (Indonesia has no daylight saving), so the day boundary is a fixed
// offset and needs no time zone database.
const JAKARTA_OFFSET_MS = 7 * 3_600_000;

/** The Asia/Jakarta calendar day that contains `now`: `start` is 00:00 and `end` the next 00:00. */
export function jakartaDayWindow(now: Date): { start: Date; end: Date } {
  const shifted = now.getTime() + JAKARTA_OFFSET_MS;
  const start = shifted - (((shifted % DAY_MS) + DAY_MS) % DAY_MS) - JAKARTA_OFFSET_MS;
  return { start: new Date(start), end: new Date(start + DAY_MS) };
}

/**
 * Questions the owner has requested since 00:00 Asia/Jakarta of `now`'s day: the `quantity` in each
 * request's params plus one per single-question regeneration job. Every request counts, failed or
 * cancelled ones too, because the quota was spent when it was created. Filters by `ownerId` itself
 * (service connection); call it inside the creation transaction, after the owner's advisory lock
 * (`generation_request:<owner>`), so the count cannot be raced.
 */
export async function questionsRequestedToday<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: PgAsyncDatabase<TQueryResult, TRelations>,
  ownerId: string,
  now: Date,
): Promise<number> {
  const { start } = jakartaDayWindow(now);
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum((${generationRequests.params}->>'quantity')::int), 0)`,
    })
    .from(generationRequests)
    .where(
      and(
        eq(generationRequests.ownerId, ownerId),
        gte(generationRequests.createdAt, start),
      ),
    );
  const [regenerations] = await db
    .select({ total: count() })
    .from(jobs)
    .where(
      and(
        eq(jobs.ownerId, ownerId),
        eq(jobs.type, REGENERATE_JOB_TYPE),
        gte(jobs.createdAt, start),
      ),
    );
  return Number(row.total) + regenerations.total;
}

export interface Spend {
  at: Date;
  tokens: number;
}

export type QuotaPlan = Result<void, { resumeAt: Date }>;

export function estimateBatchTokens(quantity: number): number {
  return quantity * TOKENS_PER_QUESTION;
}

/**
 * Pure: decides whether a batch of `estimate` tokens fits into the rolling 24 h window and, if not,
 * when enough past spend has aged out. A batch larger than the whole day's limit can never become
 * affordable, so it is let through (the runtime path deals with it) rather than given an
 * unreachable resume time.
 */
export function planQuota(input: {
  spends: readonly Spend[];
  estimate: number;
  perDay: number;
  now: Date;
}): QuotaPlan {
  const { estimate, perDay, now } = input;
  if (estimate > perDay) return ok();

  const cutoff = now.getTime() - DAY_MS;
  const live = input.spends
    .filter((spend) => spend.at.getTime() > cutoff)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  let used = live.reduce((sum, spend) => sum + spend.tokens, 0);
  if (used + estimate <= perDay) return ok();

  for (const spend of live) {
    used -= spend.tokens;
    if (used + estimate <= perDay) {
      return err({ resumeAt: new Date(spend.at.getTime() + DAY_MS) });
    }
  }
  // Defensive only: once every live spend has aged out, `used` is 0 and the estimate fits (it is at
  // most perDay, checked above), so the loop always returns. Kept so a future change cannot fall through.
  return err({ resumeAt: new Date(now.getTime() + DAY_MS) });
}

/**
 * Ruling R28: the work that is not generation (the problem solver: solving, other methods and its
 * cross-check; material structure proposals) may use at most this share of each shared Groq
 * model's day, across every teacher, so generation always keeps the rest. Tracked from ai_calls by
 * task (the solver's cross-check runs as solve_independent and is told apart by its prompt
 * version). When the share is used up those jobs defer until enough of it leaves the rolling day.
 */
export const SHARED_WORK_SHARE = 0.4;
export const SHARED_WORK_TASKS = [
  "solve_problem",
  "alternative_method",
  "propose_structure",
] as const;
const SHARED_WORK_PROMPTS = "solver-cross-check.%";

/** The spends of the shared work (R28) on one model in the last day, across owners. */
export async function readSharedWorkSpends<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: PgAsyncDatabase<TQueryResult, TRelations>,
  model: string,
  now: Date,
): Promise<Spend[]> {
  const rows = await db
    .select({
      at: aiCalls.createdAt,
      inputTokens: aiCalls.inputTokens,
      outputTokens: aiCalls.outputTokens,
    })
    .from(aiCalls)
    .where(
      and(
        eq(aiCalls.model, model),
        gt(aiCalls.createdAt, new Date(now.getTime() - DAY_MS)),
        or(
          inArray(aiCalls.task, [...SHARED_WORK_TASKS]),
          like(aiCalls.promptVersion, SHARED_WORK_PROMPTS),
        ),
      ),
    );
  return rows.map((row) => ({
    at: row.at,
    tokens: (row.inputTokens ?? 0) + (row.outputTokens ?? 0),
  }));
}

/**
 * The day plan of a shared-work call (R28): it must fit the model's whole day AND the shared
 * work's share of it. The resume time is the later of the two.
 */
export function planSharedWork(input: {
  spends: readonly Spend[];
  sharedSpends: readonly Spend[];
  estimate: number;
  perDay: number;
  now: Date;
}): QuotaPlan {
  const whole = planQuota({
    spends: input.spends,
    estimate: input.estimate,
    perDay: input.perDay,
    now: input.now,
  });
  const share = planQuota({
    spends: input.sharedSpends,
    estimate: input.estimate,
    perDay: Math.floor(input.perDay * SHARED_WORK_SHARE),
    now: input.now,
  });
  if (whole.ok && share.ok) return ok();
  const resumes = [whole, share].flatMap((plan) =>
    plan.ok ? [] : [plan.error.resumeAt],
  );
  return err({ resumeAt: new Date(Math.max(...resumes.map((at) => at.getTime()))) });
}

/**
 * The free quota is shared by every teacher, so this reads across owners (service connection).
 */
export async function readRecentSpends<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: PgAsyncDatabase<TQueryResult, TRelations>,
  model: string,
  now: Date,
): Promise<Spend[]> {
  const since = new Date(now.getTime() - DAY_MS);
  const rows = await db
    .select({
      at: aiCalls.createdAt,
      inputTokens: aiCalls.inputTokens,
      outputTokens: aiCalls.outputTokens,
    })
    .from(aiCalls)
    .where(and(eq(aiCalls.model, model), gt(aiCalls.createdAt, since)));
  return rows.map((row) => ({
    at: row.at,
    tokens: (row.inputTokens ?? 0) + (row.outputTokens ?? 0),
  }));
}

// A gateway budget that already contains the spend other runs recorded in ai_calls for one model.
// Only that model is seeded; any other model starts empty.
export function createModelBudget(
  model: string,
  spends: readonly Spend[],
  now: () => number = Date.now,
): TokenBudget {
  const limits = model === SOLVE_QUOTA.model ? SOLVE_QUOTA : GENERATE_QUOTA;
  const budget = new TokenBudget(
    { perMinute: limits.perMinute, perDay: limits.perDay },
    now,
  );
  budget.seed(
    model,
    spends.map((spend) => ({ at: spend.at.getTime(), tokens: spend.tokens })),
  );
  return budget;
}

export function createGenerationBudget(
  spends: readonly Spend[],
  now: () => number = Date.now,
): TokenBudget {
  return createModelBudget(GENERATE_QUOTA.model, spends, now);
}
