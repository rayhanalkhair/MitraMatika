// What every write of an assessment starts with: lock the owner's assessment row for the rest of the
// transaction and read its status there. The status column is client-writable under RLS (Ruling R7)
// and nothing in the database stops an edit of an approved assessment, so the lock lives here: a
// write is refused while the status is `approved`, and concurrent writes of one assessment run one
// after the other.
import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import { assessments } from "@/lib/db/schema";
import { err, ok, type Result } from "@/lib/result";

export type AssessmentDb = PgAsyncDatabase<PgQueryResultHKT, AnyRelations>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A malformed id can name nothing; checked before it reaches a uuid column. */
export const isUuid = (value: string) => UUID.test(value);

export type LockFailure = "notFound" | "approved";

/**
 * Locks the owner's visible (not trashed) assessment; `approved` when it is locked for editing.
 * `allowApproved` (reopen) takes the lock whatever the status and reports it.
 */
export async function lockAssessment(
  tx: AssessmentDb,
  input: { ownerId: string; assessmentId: string },
  options: { allowApproved?: boolean } = {},
): Promise<Result<{ rowVersion: number; approved: boolean }, LockFailure>> {
  if (!isUuid(input.assessmentId)) return err("notFound");
  const row = (
    await tx
      .select({ status: assessments.status, rowVersion: assessments.rowVersion })
      .from(assessments)
      .where(
        and(
          eq(assessments.id, input.assessmentId),
          eq(assessments.ownerId, input.ownerId),
          isNull(assessments.deletedAt),
        ),
      )
      .for("update")
  ).at(0);
  if (!row) return err("notFound");
  const approved = row.status === "approved";
  if (approved && options.allowApproved !== true) return err("approved");
  return ok({ rowVersion: row.rowVersion, approved });
}

/** The row version stays (the metadata form holds it); only the touch time moves. */
export async function touchAssessment(
  tx: AssessmentDb,
  input: { ownerId: string; assessmentId: string },
): Promise<void> {
  await tx
    .update(assessments)
    .set({ updatedAt: sql`now()` })
    .where(
      and(eq(assessments.id, input.assessmentId), eq(assessments.ownerId, input.ownerId)),
    );
}
