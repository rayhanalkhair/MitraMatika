import "server-only";
// Jobs `solve_problem` (SOL-03) and `alternative_method` (SOL-04): one text-model call per run.
// The problem is the teacher's content (C2): only routes that allow C2 receive it (Groq, R4), and
// a spent quota defers the job (decision 9: no fallback to Gemini). The call is booked first as a
// provisional ai_calls row under the model's advisory lock (Ruling R19, the lock every caller of
// gpt-oss-120b takes), then runs with no transaction open, then is settled with its real usage.
// The answer is parsed against a zod schema (unknown keys dropped, claims of unknown kinds
// dropped), its claims are run by the deterministic verifier and the solution is stored as plain
// values; nothing in it is executed.
//
// Ruling R26: the model's own claims vouch for its answer only when they recompute it from the
// problem's numbers (verify-solution.ts), and every solution is cross-checked by an independent
// second solve of the same problem (cross-check.ts) in the same run: the solution is stored first
// with its cross-check `pending` (shown as "being checked"), then settled. A run that ran out of
// time continues with the cross-check only.
//
// SOL-02 is enforced here, not only in the UI: a session without a confirmed problem text (an
// uncertain photo reading the teacher has not confirmed) is refused for good, with no model call.
// Idempotent: the payload carries how many solutions existed when the run was queued (`after`);
// a run that finds more (a retry after its write, or the trash) stores nothing and calls nothing.
// The solution is written under the session's row lock only while that count still holds.
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
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
import { aiCalls, solverSessions, solverSolutions } from "@/lib/db/schema";
import {
  PermanentJobError,
  RetryableJobError,
  type HandlerResult,
  type JobContext,
  type JobHandler,
} from "@/lib/jobs/handler";
import { logger } from "@/lib/logger";
import {
  aiErrorCode,
  createModelBudget,
  GENERATE_QUOTA,
  lockWaitMs,
  MIN_REMAINING_MS,
  pgCodeOf,
  planSharedWork,
  providerRetryDelayMs,
  QUOTA_RETRY_MS,
  readRecentSpends,
  readSharedWorkSpends,
  toDbStatus,
  type Gateway,
} from "@/features/generation";
import { solutionAnswerSchema, type SolutionAnswer } from "../schema/answers";
import { crossCheckSolution } from "./cross-check";
import { MAX_METHODS } from "../schema/solver";
import { buildSolvePrompt, sameMethod } from "./prompts/solve-problem.id";
import { neverSent, type SolverDb } from "./quota";
import { settleReport, verifySolution, type VerificationReport } from "./verify-solution";

const ROUTE = defaultRouting.solve_problem[0];
const MAX_OUTPUT_TOKENS = ROUTE.maxOutputTokens ?? 3_000;
/** About one call: the prompt (at most ~2,500 tokens with a long problem) and the answer. */
const SOLVE_ESTIMATE_TOKENS = 5_500;
const RESERVED = "reserved";

const payloadSchema = z.object({
  sessionId: z.uuid(),
  after: z.number().int().min(0).max(MAX_METHODS),
  counted: z.boolean().optional(),
  excludeMethods: z.array(z.string().max(200)).max(MAX_METHODS).optional(),
});

export interface SolverJobDeps {
  db: SolverDb;
  createGateway: (budget: TokenBudget) => Gateway;
  now?: () => Date;
}

type Mode = "solve" | "alternative";

const SKIPPED: HandlerResult = {
  kind: "done",
  progress: { step: "skipped", done: 0, total: 0 },
};

const MESSAGES = {
  solve_invalid: "The solver job payload is not valid.",
  solve_not_found: "The session of the solver job was not found.",
  solve_unconfirmed: "The problem text has not been confirmed by the teacher.",
  solve_state: "The session cannot take another method now.",
  solve_invalid_output: "The AI answer did not match the solution format.",
  solve_blocked: "The problem cannot be sent to the AI.",
  provider_unavailable: "The AI service is not available; it will be retried.",
} as const;

function failure(code: keyof typeof MESSAGES): PermanentJobError {
  return new PermanentJobError(code, MESSAGES[code]);
}

type Booking =
  | { kind: "wait" }
  | { kind: "quota"; resumeAt: Date }
  | {
      kind: "booked";
      spends: Awaited<ReturnType<typeof readRecentSpends>>;
      reservationId: string;
    };

/**
 * One solver run (shared by both jobs): the guards, the booked model call, the verification and
 * the guarded write.
 */
async function runSolver(
  deps: SolverJobDeps,
  ctx: JobContext,
  mode: Mode,
): Promise<HandlerResult> {
  const { db } = deps;
  const clock = deps.now ?? (() => new Date());
  const parsed = payloadSchema.safeParse(ctx.job.payload);
  if (!parsed.success) throw failure("solve_invalid");
  const { sessionId, after } = parsed.data;
  const { ownerId } = ctx;
  const ofSession = and(
    eq(solverSessions.id, sessionId),
    eq(solverSessions.ownerId, ownerId),
  );

  const session = (
    await db
      .select({
        status: solverSessions.status,
        confirmedMd: solverSessions.confirmedMd,
        deletedAt: solverSessions.deletedAt,
      })
      .from(solverSessions)
      .where(ofSession)
      .limit(1)
  ).at(0);
  // Absent or another owner's: nothing of it is touched.
  if (!session) throw failure("solve_not_found");
  if (session.deletedAt) return SKIPPED;
  const stored = await db
    .select({
      id: solverSolutions.id,
      label: solverSolutions.methodLabel,
      finalAnswer: solverSolutions.finalAnswer,
      report: solverSolutions.verificationReport,
    })
    .from(solverSolutions)
    .where(
      and(eq(solverSolutions.sessionId, sessionId), eq(solverSolutions.ownerId, ownerId)),
    )
    .orderBy(asc(solverSolutions.createdAt), asc(solverSolutions.id));

  /**
   * The cross-check of this run's solution (R26), then its settled badge. Written only while the
   * cross-check is still pending, so a second run cannot settle it twice.
   */
  const crossCheck = async (solution: (typeof stored)[number], problem: string) => {
    if (ctx.deadline - clock().getTime() < MIN_REMAINING_MS) {
      return {
        kind: "continue" as const,
        progress: { step: "cross_check", done: 1, total: 2 },
      };
    }
    const value = (solution.finalAnswer as { value?: unknown } | null)?.value;
    const outcome = await crossCheckSolution(
      { db, createGateway: deps.createGateway, now: clock },
      {
        ownerId,
        jobId: ctx.job.id,
        problemMd: problem,
        finalValue: typeof value === "string" ? value : "",
        deadline: ctx.deadline,
      },
    );
    const settled = settleReport(
      solution.report as VerificationReport,
      outcome.verdict,
      outcome.answer,
    );
    await db
      .update(solverSolutions)
      .set({
        verificationStatus: toDbStatus(settled.status),
        verificationReport: settled.report,
      })
      .where(
        and(
          eq(solverSolutions.id, solution.id),
          eq(solverSolutions.ownerId, ownerId),
          sql`${solverSolutions.verificationReport}->>'crossCheck' = 'pending'`,
        ),
      );
    return {
      kind: "done" as const,
      progress: { step: "done", done: 2, total: 2 },
    };
  };

  if (stored.length > after) {
    // This run's solution is stored: only its cross-check may be left (a retry, or a run that
    // continued after its time ran out).
    const mine = stored[after];
    const pending =
      (mine.report as { crossCheck?: unknown } | null)?.crossCheck === "pending";
    if (!pending || session.confirmedMd === null) return SKIPPED;
    return crossCheck(mine, session.confirmedMd);
  }
  const problemMd = session.confirmedMd;
  if (problemMd === null || session.status === "needs_confirmation") {
    throw failure("solve_unconfirmed");
  }
  if (mode === "alternative" && (session.status !== "solved" || after >= MAX_METHODS)) {
    throw failure("solve_state");
  }
  if (ctx.deadline - clock().getTime() < MIN_REMAINING_MS) {
    return { kind: "defer", runAfter: new Date(ctx.deadline) };
  }

  const exclude =
    mode === "alternative"
      ? [...(parsed.data.excludeMethods ?? []), ...stored.map((row) => row.label)]
      : [];
  const task = mode === "solve" ? "solve_problem" : "alternative_method";
  const { system, prompt, version } = buildSolvePrompt({
    problemMd,
    excludeMethods: exclude,
  });
  const waiting: HandlerResult = { kind: "defer", runAfter: new Date(ctx.deadline) };

  /** A run that fails for good leaves a first solve `failed`, so the teacher may try again. */
  const giveUp = async (error: unknown) => {
    if (
      mode === "solve" &&
      (error instanceof PermanentJobError || ctx.job.attempts + 1 >= ctx.job.maxAttempts)
    ) {
      await db
        .update(solverSessions)
        .set({ status: "failed", updatedAt: clock() })
        .where(and(ofSession, eq(solverSessions.status, "ready")));
    }
  };

  // 1. Book under the model's lock (shared with generation's batches and regenerations).
  let booked: Booking;
  try {
    booked = await db.transaction(async (rawTx): Promise<Booking> => {
      const tx = rawTx as unknown as SolverDb;
      const waitMs = lockWaitMs(ctx.deadline, clock().getTime());
      await tx.execute(sql.raw(`set local lock_timeout = '${String(waitMs)}ms'`));
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`ai:${ROUTE.model}`}, 0))`,
      );
      await tx.execute(sql.raw("set local lock_timeout = 0"));
      if (ctx.deadline - clock().getTime() < MIN_REMAINING_MS) return { kind: "wait" };
      const now = clock();
      const spends = await readRecentSpends(tx, ROUTE.model, now);
      // R28: solving shares generation's model; together with the other shared work it may use
      // only its part of the model's day, so generation always keeps the rest.
      const plan = planSharedWork({
        spends,
        sharedSpends: await readSharedWorkSpends(tx, ROUTE.model, now),
        estimate: SOLVE_ESTIMATE_TOKENS,
        perDay: GENERATE_QUOTA.perDay,
        now,
      });
      if (!plan.ok) return { kind: "quota", resumeAt: plan.error.resumeAt };
      const [reservation] = await tx
        .insert(aiCalls)
        .values({
          ownerId,
          jobId: ctx.job.id,
          task,
          provider: ROUTE.provider,
          model: ROUTE.model,
          promptVersion: version,
          inputTokens: SOLVE_ESTIMATE_TOKENS - MAX_OUTPUT_TOKENS,
          outputTokens: MAX_OUTPUT_TOKENS,
          outcome: "error",
          errorCode: RESERVED,
          createdAt: now,
        })
        .returning({ id: aiCalls.id });
      return { kind: "booked", spends, reservationId: reservation.id };
    });
  } catch (error) {
    if (pgCodeOf(error) === "55P03") return waiting;
    throw error;
  }
  if (booked.kind === "wait") return waiting;
  if (booked.kind === "quota") return { kind: "defer", runAfter: booked.resumeAt };

  // 2. The model call, outside any transaction.
  const spent: AiUsage = { inputTokens: 0, outputTokens: 0 };
  const startedAt = clock().getTime();
  const ours = and(eq(aiCalls.id, booked.reservationId), eq(aiCalls.errorCode, RESERVED));
  const settle = (outcome: "ok" | "error", errorCode: string | null) =>
    db
      .update(aiCalls)
      .set({
        inputTokens: spent.inputTokens,
        outputTokens: spent.outputTokens,
        latencyMs: clock().getTime() - startedAt,
        outcome,
        errorCode,
      })
      .where(ours);
  let answer: SolutionAnswer;
  try {
    const result = await deps
      .createGateway(
        createModelBudget(ROUTE.model, booked.spends, () => clock().getTime()),
      )
      .generate({
        task,
        dataClass: "C2",
        system,
        prompt,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        deadline: ctx.deadline,
        onUsage: (usage) => {
          spent.inputTokens += usage.inputTokens;
          spent.outputTokens += usage.outputTokens;
        },
        parse: (raw) => {
          const value = solutionAnswerSchema.parse(raw);
          if (exclude.some((label) => sameMethod(label, value.method))) {
            throw new Error(
              `Metode "${value.method}" sudah ditampilkan; pakai metode yang berbeda.`,
            );
          }
          return value;
        },
      });
    answer = result.value;
  } catch (error) {
    // Refused before anything was sent: no call, so no spend and no run to count (D1).
    if (neverSent(error, spent)) await db.delete(aiCalls).where(ours);
    else await settle("error", aiErrorCode(error));
    if (error instanceof AiQuotaError) {
      return { kind: "defer", runAfter: new Date(clock().getTime() + QUOTA_RETRY_MS) };
    }
    if (error instanceof AiProviderError && error.kind === "rate_limited") {
      return {
        kind: "defer",
        runAfter: new Date(clock().getTime() + providerRetryDelayMs(error.retryAfterMs)),
      };
    }
    let thrown: Error;
    if (error instanceof AiOutputError) thrown = failure("solve_invalid_output");
    else if (error instanceof AiPolicyError) thrown = failure("solve_blocked");
    else if (error instanceof AiProviderError) {
      thrown = new RetryableJobError(
        "provider_unavailable",
        MESSAGES.provider_unavailable,
      );
    } else thrown = error instanceof Error ? error : new Error("solver failed");
    logger.warn(
      {
        module: "solver",
        jobId: ctx.job.id,
        code: thrown instanceof PermanentJobError ? thrown.code : "retry",
      },
      "solver: a solve failed",
    );
    await giveUp(thrown);
    throw thrown;
  }
  await settle("ok", null);

  // 3. Verify, then write under the session's row lock while nothing else was stored.
  const verification = verifySolution(answer, { problemMd, crossCheck: "pending" });
  const written = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as SolverDb;
    const live = await tx
      .select({ id: solverSessions.id })
      .from(solverSessions)
      .where(and(ofSession, isNull(solverSessions.deletedAt)))
      .for("update");
    if (live.length === 0) return null;
    const [existing] = await tx
      .select({ n: count() })
      .from(solverSolutions)
      .where(
        and(
          eq(solverSolutions.sessionId, sessionId),
          eq(solverSolutions.ownerId, ownerId),
        ),
      );
    if (existing.n !== after) return null;
    const now = clock();
    const [row] = await tx
      .insert(solverSolutions)
      .values({
        ownerId,
        sessionId,
        methodLabel: answer.method,
        isAlternative: after > 0,
        steps: answer.steps.map((step) => ({
          title: step.title?.trim() ? step.title.trim() : null,
          bodyMd: step.body_md,
        })),
        finalAnswer: {
          value: answer.final_answer.value,
          unit: answer.final_answer.unit?.trim() ? answer.final_answer.unit.trim() : null,
          rounding: answer.final_answer.rounding?.trim()
            ? answer.final_answer.rounding.trim()
            : null,
        },
        verificationStatus: toDbStatus(verification.status),
        verificationReport: verification.report,
        createdAt: now,
      })
      .returning({
        id: solverSolutions.id,
        label: solverSolutions.methodLabel,
        finalAnswer: solverSolutions.finalAnswer,
        report: solverSolutions.verificationReport,
      });
    await tx
      .update(solverSessions)
      .set({ status: "solved", updatedAt: now })
      .where(ofSession);
    return row;
  });
  if (!written) return SKIPPED;
  return crossCheck(written, problemMd);
}

/** Job `solve_problem`: the first solution of a session. */
export function createSolveProblemHandler(deps: SolverJobDeps): JobHandler {
  return (ctx) => solveProblem(deps, ctx);
}

/**
 * Solves the session named by the job (`{ sessionId, after }`): steps, final answer with units
 * and rounding, and the verifier's status of its claims, stored as one solution.
 */
export function solveProblem(
  deps: SolverJobDeps,
  ctx: JobContext,
): Promise<HandlerResult> {
  return runSolver(deps, ctx, "solve");
}

/** "Show another method": a solution whose method differs from every label shown so far. */
export function solveWithAnotherMethod(
  deps: SolverJobDeps,
  ctx: JobContext,
): Promise<HandlerResult> {
  return runSolver(deps, ctx, "alternative");
}
