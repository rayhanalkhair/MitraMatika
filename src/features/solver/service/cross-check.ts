import "server-only";
// The independent cross-check of one solution (Ruling R26): the confirmed problem is solved once
// more by the generation cross-check's model (task solve_independent, Groq, C2 like every solver
// call) without the first solution, and only the final answers are compared. It belongs to the
// same run as the solve (same job, so it never counts as another solve of the daily cap). The
// call is booked as a provisional ai_calls row under that model's advisory lock (R19, the lock
// generation's cross-check takes too). Anything that keeps it from answering (day budget, lock
// wait, rate limit, provider failure, unusable answer) gives `unavailable`: the solution then
// stays "could not be verified"; it is never deferred for a day.
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { defaultRouting, type AiUsage, type TokenBudget } from "@/lib/ai";
import { aiCalls } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import {
  aiErrorCode,
  createModelBudget,
  lockWaitMs,
  planSharedWork,
  readRecentSpends,
  readSharedWorkSpends,
  SOLVE_QUOTA,
  type Gateway,
} from "@/features/generation";
import {
  buildCrossCheckPrompt,
  CROSS_CHECK_PROMPT_VERSION,
} from "./prompts/cross-check.id";
import type { SolverDb } from "./quota";
import { crossCheckAgreement, type CrossCheck } from "./verify-solution";

const TASK = "solve_independent";
const ROUTE = defaultRouting.solve_independent[0];
const MAX_OUTPUT_TOKENS = 1_200;
/** About one call: the problem (up to ~1,500 tokens), the rules and the short answer. */
const ESTIMATE_TOKENS = 3_000;
const RESERVED = "reserved";

const answerSchema = z.object({ answer: z.string().trim().min(1).max(200) });

export interface CrossCheckDeps {
  db: SolverDb;
  createGateway: (budget: TokenBudget) => Gateway;
  now: () => Date;
}

export async function crossCheckSolution(
  deps: CrossCheckDeps,
  input: {
    ownerId: string;
    jobId: string;
    problemMd: string;
    finalValue: string;
    deadline: number;
  },
): Promise<{ verdict: Exclude<CrossCheck, "pending">; answer: string | null }> {
  const { db, now } = deps;
  const unavailable = { verdict: "unavailable" as const, answer: null };
  let booked: { spends: Awaited<ReturnType<typeof readRecentSpends>>; id: string } | null;
  try {
    booked = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as SolverDb;
      const waitMs = lockWaitMs(input.deadline, now().getTime());
      await tx.execute(sql.raw(`set local lock_timeout = '${String(waitMs)}ms'`));
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`ai:${ROUTE.model}`}, 0))`,
      );
      await tx.execute(sql.raw("set local lock_timeout = 0"));
      const at = now();
      const spends = await readRecentSpends(tx, ROUTE.model, at);
      // R28: the solver's cross-checks share the model with generation's; they may use only
      // the shared work's part of its day.
      const plan = planSharedWork({
        spends,
        sharedSpends: await readSharedWorkSpends(tx, ROUTE.model, at),
        estimate: ESTIMATE_TOKENS,
        perDay: SOLVE_QUOTA.perDay,
        now: at,
      });
      if (!plan.ok) return null;
      const [row] = await tx
        .insert(aiCalls)
        .values({
          ownerId: input.ownerId,
          jobId: input.jobId,
          task: TASK,
          provider: ROUTE.provider,
          model: ROUTE.model,
          promptVersion: CROSS_CHECK_PROMPT_VERSION,
          inputTokens: ESTIMATE_TOKENS - MAX_OUTPUT_TOKENS,
          outputTokens: MAX_OUTPUT_TOKENS,
          outcome: "error",
          errorCode: RESERVED,
          createdAt: at,
        })
        .returning({ id: aiCalls.id });
      return { spends, id: row.id };
    });
  } catch {
    // The model's lock was not free in time (or the booking failed): no cross-check this run.
    return unavailable;
  }
  if (!booked) return unavailable;

  const spent: AiUsage = { inputTokens: 0, outputTokens: 0 };
  const startedAt = now().getTime();
  const settle = (outcome: "ok" | "error", errorCode: string | null) =>
    db
      .update(aiCalls)
      .set({
        inputTokens: spent.inputTokens,
        outputTokens: spent.outputTokens,
        latencyMs: now().getTime() - startedAt,
        outcome,
        errorCode,
      })
      .where(and(eq(aiCalls.id, booked.id), eq(aiCalls.errorCode, RESERVED)));
  const { system, prompt } = buildCrossCheckPrompt(input.problemMd);
  try {
    const result = await deps
      .createGateway(createModelBudget(ROUTE.model, booked.spends, () => now().getTime()))
      .generate({
        task: TASK,
        dataClass: "C2",
        system,
        prompt,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        deadline: input.deadline,
        onUsage: (usage) => {
          spent.inputTokens += usage.inputTokens;
          spent.outputTokens += usage.outputTokens;
        },
        parse: (raw) => answerSchema.parse(raw),
      });
    await settle("ok", null);
    const answer = result.value.answer;
    return { verdict: crossCheckAgreement(input.finalValue, answer), answer };
  } catch (error) {
    await settle("error", aiErrorCode(error));
    logger.warn(
      { module: "solver", jobId: input.jobId, code: aiErrorCode(error) },
      "solver: the cross-check could not run",
    );
    return unavailable;
  }
}
