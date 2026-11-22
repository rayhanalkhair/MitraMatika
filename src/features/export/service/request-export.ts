// Starts an export: the teacher's "Export" button. Service connection with explicit owner filters
// (jobs are written by the server only); the gate is the same verifyApproval the job runs again.
import "server-only";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { verifyApproval, type AssessmentDb } from "@/features/assessments";
import { jobs } from "@/lib/db/schema";
import { createJobQueue } from "@/lib/jobs/queue";
import { err, ok, type Result } from "@/lib/result";
import { EXPORT_JOB_TYPE } from "./export-job";

/** Exports one teacher may start in any 60 minutes (each renders three PDFs). */
export const EXPORT_HOURLY_LIMIT = 10;
const HOUR_MS = 3_600_000;
const ACTIVE = ["queued", "running", "deferred"];
// A failed render (a document too large, a layout error) is not worth retrying more than once.
const MAX_ATTEMPTS = 2;

export type ExportRequestFailure =
  | { reason: "notFound" | "notApproved" | "stale" }
  | { reason: "pending"; jobId: string }
  | { reason: "hourlyLimit"; limit: number; resetsAt: Date };

/** The export of this assessment that has not finished yet, if any. */
export async function findPendingExport(
  db: AssessmentDb,
  input: { ownerId: string; assessmentId: string },
): Promise<string | null> {
  const row = (
    await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.ownerId, input.ownerId),
          eq(jobs.type, EXPORT_JOB_TYPE),
          inArray(jobs.status, ACTIVE),
          sql`${jobs.payload}->>'assessmentId' = ${input.assessmentId}`,
        ),
      )
      .limit(1)
  ).at(0);
  return row?.id ?? null;
}

/**
 * Queues `render_export` for the owner's approved assessment with the hash the gate computed now.
 * Serialised per owner by an advisory lock, so the pending check and the hourly count cannot be
 * raced. Refuses an assessment that does not pass the gate, answers with the pending job of the
 * same assessment, and refuses past EXPORT_HOURLY_LIMIT (`resetsAt`: when the oldest export of the
 * last hour leaves the window).
 */
export async function requestExport(
  db: AssessmentDb,
  input: { ownerId: string; assessmentId: string; now: Date },
): Promise<Result<{ jobId: string }, ExportRequestFailure>> {
  const { ownerId, assessmentId, now } = input;
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as AssessmentDb;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`export_request:${ownerId}`}, 0))`,
    );
    const gate = await verifyApproval(tx, { ownerId, assessmentId });
    if (!gate.ok) return err<ExportRequestFailure>({ reason: gate.error });

    const pending = await findPendingExport(tx, { ownerId, assessmentId });
    if (pending) return err<ExportRequestFailure>({ reason: "pending", jobId: pending });

    const recent = await tx
      .select({ createdAt: jobs.createdAt })
      .from(jobs)
      .where(
        and(
          eq(jobs.ownerId, ownerId),
          eq(jobs.type, EXPORT_JOB_TYPE),
          gt(jobs.createdAt, new Date(now.getTime() - HOUR_MS)),
        ),
      )
      .orderBy(asc(jobs.createdAt))
      .limit(EXPORT_HOURLY_LIMIT);
    if (recent.length >= EXPORT_HOURLY_LIMIT) {
      return err<ExportRequestFailure>({
        reason: "hourlyLimit",
        limit: EXPORT_HOURLY_LIMIT,
        resetsAt: new Date(recent[0].createdAt.getTime() + HOUR_MS),
      });
    }

    const job = await createJobQueue(tx, () => now).enqueue({
      ownerId,
      type: EXPORT_JOB_TYPE,
      payload: { assessmentId, snapshotHash: gate.data.hash },
      runAfter: now,
      maxAttempts: MAX_ATTEMPTS,
      // The hourly count reads createdAt against `now`, so the row carries the same clock.
      createdAt: now,
    });
    return ok({ jobId: job.id });
  });
}
