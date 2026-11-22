import { eq } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import { runAsUser } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";
import { DEFAULT_LEASE_MS } from "./runner";

export type JobStatusValue =
  "queued" | "running" | "succeeded" | "failed" | "deferred" | "cancelled";

// The shape teachers see. Deliberately excludes payload, lock token, attempts, correlation id and
// the stored error message (technical text): the client picks Indonesian copy from `progress.messageKey`
// and `error.code`.
export interface PublicJobStatus {
  id: string;
  type: string;
  status: JobStatusValue;
  progress: Record<string, unknown> | null;
  error: { code: string } | null;
  runAfter: string;
  createdAt: string;
  updatedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Whether the runner has work for this job right now: queued or deferred with `run_after` reached,
 * or running with a lease older than the lease length (a crashed runner). Mirrors the claim and
 * reclaim conditions in queue.ts.
 */
export function isJobDue(
  job: { status: string; runAfter: Date; lockedAt: Date | null },
  now: Date,
  leaseMs: number = DEFAULT_LEASE_MS,
): boolean {
  if (job.status === "queued" || job.status === "deferred") {
    return job.runAfter.getTime() <= now.getTime();
  }
  if (job.status === "running") {
    return job.lockedAt !== null && job.lockedAt.getTime() < now.getTime() - leaseMs;
  }
  return false;
}

// Reads the job as the signed-in teacher: Postgres RLS (`owner_id = auth.uid()`) decides what is
// visible, so another teacher's job is simply not found.
export async function readJobStatus<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: PgAsyncDatabase<TQueryResult, TRelations>,
  userId: string,
  jobId: string,
): Promise<PublicJobStatus | null> {
  return (await readJobStatusAndDue(db, userId, jobId))?.job ?? null;
}

/** The public status plus whether the job is due (never part of the public shape). */
export async function readJobStatusAndDue<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: PgAsyncDatabase<TQueryResult, TRelations>,
  userId: string,
  jobId: string,
  now: () => Date = () => new Date(),
): Promise<{ job: PublicJobStatus; due: boolean } | null> {
  const rows = await runAsUser(db, userId, (tx) =>
    tx
      .select({
        id: jobs.id,
        type: jobs.type,
        status: jobs.status,
        progress: jobs.progress,
        error: jobs.error,
        runAfter: jobs.runAfter,
        lockedAt: jobs.lockedAt,
        createdAt: jobs.createdAt,
        updatedAt: jobs.updatedAt,
      })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1),
  );
  const row = rows.at(0);
  if (!row) return null;
  const code = errorCode(row.error);
  return {
    job: {
      id: row.id,
      type: row.type,
      status: row.status as JobStatusValue,
      progress: asRecord(row.progress),
      error: code ? { code } : null,
      runAfter: row.runAfter.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    },
    due: isJobDue(row, now()),
  };
}
