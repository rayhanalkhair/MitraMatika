import { and, asc, desc, eq, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import { jobRuns, jobs } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import type { Claim, ClaimedJob, EnqueueInput, JobQueue, JobRow } from "./types";

const LEASE_EXPIRED_ERROR = JSON.stringify({
  code: "lease_expired",
  message: "The runner stopped before finishing this job.",
});

function toClaimed(row: JobRow): ClaimedJob {
  if (!row.lockToken) throw new Error("claimed job has no lock token");
  return { ...row, lockToken: row.lockToken };
}

/**
 * All queue SQL lives here. `db` is the service connection (RLS is bypassed): the queue is the one
 * component that claims across owners, and it never exposes rows to teachers. A claim hands out a
 * lock token, and every later transition must present it, so a runner that lost its lease cannot
 * overwrite the job.
 */
export function createJobQueue<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: PgAsyncDatabase<TQueryResult, TRelations>,
  clock: () => Date = () => new Date(),
): JobQueue {
  // Every transition after a claim must present the claim's lock token.
  const held = (claim: Claim) =>
    and(
      eq(jobs.id, claim.id),
      eq(jobs.lockToken, claim.lockToken),
      eq(jobs.status, "running"),
    );

  // A reclaimed job's last attempt never finished: an orphan is a `running` row with no
  // `finished_at`; close it as failed (`lease_expired`). History is
  // best effort, so a failure here is logged and must not undo the reclaim.
  async function closeOrphanedRuns(
    jobIds: string[],
    now: Date,
    cutoff: Date,
  ): Promise<void> {
    if (jobIds.length === 0) return;
    try {
      await db
        .update(jobRuns)
        .set({
          finishedAt: now,
          outcome: "failed",
          errorCode: "lease_expired",
          durationMs: sql`greatest(0, (extract(epoch from (${now.toISOString()}::timestamptz - ${jobRuns.startedAt})) * 1000)::integer)`,
        })
        // The run's `started_at` is the claim's `locked_at`, so `startedAt < cutoff` holds exactly when
        // the reclaim's `lockedAt < cutoff` did; an attempt a concurrent runner opened after the
        // requeue starts later, so it is never touched.
        .where(
          and(
            inArray(jobRuns.jobId, jobIds),
            eq(jobRuns.outcome, "running"),
            isNull(jobRuns.finishedAt),
            lt(jobRuns.startedAt, cutoff),
          ),
        );
    } catch (error) {
      logger.error(
        {
          module: "jobs",
          step: "reclaim",
          errorName: error instanceof Error ? error.name : "unknown",
        },
        "jobs: could not close orphaned job_runs",
      );
    }
  }

  const release = { lockedAt: null, lockToken: null } as const;

  return {
    async enqueue(input: EnqueueInput) {
      const [row] = await db
        .insert(jobs)
        .values({
          ownerId: input.ownerId,
          type: input.type,
          payload: input.payload ?? {},
          priority: input.priority,
          maxAttempts: input.maxAttempts,
          status: input.status,
          runAfter: input.runAfter ?? clock(),
          ...(input.createdAt ? { createdAt: input.createdAt } : {}),
        })
        .returning();
      return row;
    },

    async claimNext() {
      const now = clock();
      const next = db
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(inArray(jobs.status, ["queued", "deferred"]), lte(jobs.runAfter, now)))
        .orderBy(
          desc(jobs.priority),
          asc(jobs.runAfter),
          asc(jobs.createdAt),
          asc(jobs.id),
        )
        .limit(1)
        .for("update", { skipLocked: true });
      const row = (
        await db
          .update(jobs)
          .set({
            status: "running",
            lockedAt: now,
            lockToken: sql`gen_random_uuid()`,
            updatedAt: now,
          })
          .where(inArray(jobs.id, next))
          .returning()
      ).at(0);
      return row ? toClaimed(row) : null;
    },

    async complete(claim, progress) {
      const rows = await db
        .update(jobs)
        .set({
          status: "succeeded",
          ...release,
          error: null,
          progress,
          updatedAt: clock(),
        })
        .where(held(claim))
        .returning({ id: jobs.id });
      return rows.length === 1;
    },

    async continueJob(claim, progress) {
      const now = clock();
      const rows = await db
        .update(jobs)
        .set({ status: "queued", ...release, runAfter: now, progress, updatedAt: now })
        .where(held(claim))
        .returning({ id: jobs.id });
      return rows.length === 1;
    },

    async defer(claim, runAfter, progress) {
      const rows = await db
        .update(jobs)
        .set({ status: "deferred", ...release, runAfter, progress, updatedAt: clock() })
        .where(held(claim))
        .returning({ id: jobs.id });
      return rows.length === 1;
    },

    async fail(claim, error, retryAt) {
      const rows = await db
        .update(jobs)
        .set({
          status: retryAt ? "queued" : "failed",
          attempts: sql`${jobs.attempts} + 1`,
          runAfter: retryAt ?? undefined,
          error: {
            code: error.code,
            message: Array.from(error.message).slice(0, 300).join(""),
          },
          ...release,
          updatedAt: clock(),
        })
        .where(held(claim))
        .returning({ id: jobs.id });
      return rows.length === 1;
    },

    async reclaimStale(leaseMs) {
      const now = clock();
      const cutoff = new Date(now.getTime() - leaseMs);
      const nowIso = now.toISOString();
      // Every right-hand side reads the OLD row, so `attempts + 1 < max_attempts` is evaluated
      // against the attempts before this crash was counted.
      const rows = await db
        .update(jobs)
        .set({
          attempts: sql`${jobs.attempts} + 1`,
          status: sql`case when ${jobs.attempts} + 1 < ${jobs.maxAttempts} then 'queued' else 'failed' end`,
          runAfter: sql`case when ${jobs.attempts} + 1 < ${jobs.maxAttempts} then ${nowIso}::timestamptz else ${jobs.runAfter} end`,
          error: sql`${LEASE_EXPIRED_ERROR}::jsonb`,
          ...release,
          updatedAt: now,
        })
        .where(and(eq(jobs.status, "running"), lt(jobs.lockedAt, cutoff)))
        .returning({ id: jobs.id });
      await closeOrphanedRuns(
        rows.map((row) => row.id),
        now,
        cutoff,
      );
      return rows.length;
    },
  };
}
