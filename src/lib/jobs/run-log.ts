import { and, eq, isNull } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import { jobRuns } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import type { ClaimedJob, JobRunLog } from "./types";

/**
 * Writes one `job_runs` row per attempt: inserted with outcome `running` (and `finished_at` null)
 * when the job is claimed, closed with the real outcome when the attempt ends. `started_at` is the
 * claim's `locked_at`, the same instant, so the queue's orphan close (`started_at < cutoff`) holds
 * exactly when the reclaim (`locked_at < cutoff`) does. `db` is the service connection. The log is best effort: a failed write is logged (error
 * name only) and never reaches the caller, so history problems cannot stop jobs from running. An
 * attempt that is never closed (the process died) is closed as `lease_expired` by the queue when
 * the job is reclaimed.
 */
export function createJobRunLog<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: PgAsyncDatabase<TQueryResult, TRelations>,
  clock: () => Date = () => new Date(),
): JobRunLog {
  return {
    async start(job: ClaimedJob) {
      const startedAt = job.lockedAt ?? clock();
      try {
        const [row] = await db
          .insert(jobRuns)
          .values({
            jobId: job.id,
            ownerId: job.ownerId,
            startedAt,
            outcome: "running",
          })
          .returning({ id: jobRuns.id });
        return { id: row.id, startedAt };
      } catch (error) {
        logWriteFailure("start", error);
        return null;
      }
    },

    async finish(run, outcome, errorCode) {
      if (!run) return;
      const finishedAt = clock();
      try {
        await db
          .update(jobRuns)
          .set({
            finishedAt,
            outcome,
            errorCode,
            durationMs: Math.max(0, finishedAt.getTime() - run.startedAt.getTime()),
          })
          // Only an open attempt: one already closed by a lease reclaim keeps that outcome.
          .where(and(eq(jobRuns.id, run.id), isNull(jobRuns.finishedAt)));
      } catch (error) {
        logWriteFailure("finish", error);
      }
    },
  };
}

function logWriteFailure(step: "start" | "finish", error: unknown): void {
  logger.error(
    { module: "jobs", step, errorName: error instanceof Error ? error.name : "unknown" },
    "jobs: could not write job_runs",
  );
}
