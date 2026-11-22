// The record of each /api/jobs/run call: one ownerless audit_log row (decision 12 of the
// stack-alignment plan). It is the owner's evidence that the daily cron fires, since Vercel Hobby
// keeps runtime logs for one hour. Step names, outcomes, durations and the runner's count and
// budget only: no ids, no user data.
import "server-only";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import { auditLog } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import type { RunTrigger } from "./run-route";
import type { TickResult } from "./tick";

export const JOBS_RUN_ACTION = "jobs_run";

/** Writes the run's record. Never throws: a failure is logged (error name only). */
export async function recordRun<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: PgAsyncDatabase<TQueryResult, TRelations>,
  input: { at: Date; trigger: RunTrigger; result: TickResult },
): Promise<void> {
  const { result } = input;
  try {
    await db.insert(auditLog).values({
      ownerId: null,
      action: JOBS_RUN_ACTION,
      metadata: {
        trigger: input.trigger,
        steps: result.steps.map((step) => ({
          name: step.name,
          outcome: step.outcome,
          ms: step.ms,
          ...(step.backlogLeft ? { backlogLeft: true } : {}),
        })),
        jobs: result.jobsError
          ? { failed: true, error: result.jobsError, budgetMs: result.budgetMs }
          : result.jobs
            ? { ran: result.jobs.ran, budgetMs: result.budgetMs }
            : null,
      },
      createdAt: input.at,
    });
  } catch (error) {
    logger.error(
      { module: "jobs", err: error instanceof Error ? error.name : typeof error },
      "jobs: could not record the run",
    );
  }
}
