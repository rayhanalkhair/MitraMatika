// The trash for assessments (decision 10): move to the trash, restore, delete for good, the daily
// purge and the list. Like the question trash, the writes run on the service connection and name
// owner_id in every statement: trashing cancels the assessment's exports that have not started
// (jobs are server-written) and a permanent delete writes deletion_log. The list runs under
// runAsUser (the page) and names owner_id as well.
//
// Trashing does NOT reopen an approved assessment: status, approval time and snapshot hash stay, so
// a restore gives it back exactly as it was (still exportable when the gate still passes). While it
// is in the trash every read and write of the assessments feature, the export gate and the
// download route treat it as not found.
//
// Deleting for good, in one transaction of its own under the row lock: first every database write
// (the row delete, which cascades to sections, items, export rows and question usage (R8), and the
// deletion_log entry), then the stored export files, last before the commit. A database failure
// therefore happens before any file is touched; a storage failure (or a call that hangs past its
// bound) throws and rolls the rows back, so the row stays in the trash with whatever files are
// left and the next try finishes them (deleting is idempotent). Only a failure of the commit itself
// can leave a trashed row whose files are gone. No file is ever orphaned by a half-done delete.
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  sql,
} from "drizzle-orm";
import {
  assessmentItems,
  assessments,
  assessmentSections,
  deletionLog,
  exports,
  jobs,
  questionUsages,
} from "@/lib/db/schema";
import type { AnyDb } from "@/features/generation";
import { logger } from "@/lib/logger";
import { err, ok, type Result } from "@/lib/result";
import type { ObjectStore } from "@/lib/storage/types";
import { safeErrorSummary } from "./error-summary";
import { daysLeft, purgeAfterFrom, type TrashFailure } from "./retention";
import { exportRunPrefix, isOwnExportKey, RENDER_EXPORT_JOB_TYPE } from "./storage-keys";

/** The object store, asked for only when there is something to delete in it. */
export type StoreSource = () => ObjectStore;

export const DELETION_ENTITY_ASSESSMENT = "assessment";
// One purge run deletes at most this many assessments; the rest go the next day.
const PURGE_BATCH = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_STARTED = ["queued", "deferred"];

export interface AssessmentPurgeCounts {
  sections: number;
  items: number;
  /** Export rows (one per stored file of a finished run). */
  exports: number;
  /** Objects removed from storage, including those of failed runs that left no rows. */
  exportFiles: number;
  usages: number;
}

const ofAssessment = (ownerId: string, assessmentId: string) =>
  and(eq(assessments.id, assessmentId), eq(assessments.ownerId, ownerId));

/** Whether the owner has this assessment at all (to tell notFound from notInTrash). */
async function ownsAssessment(db: AnyDb, ownerId: string, assessmentId: string) {
  const rows = await db
    .select({ id: assessments.id })
    .from(assessments)
    .where(ofAssessment(ownerId, assessmentId))
    .limit(1);
  return rows.length > 0;
}

/** Cancels the assessment's exports that have not started; a running one fails at its gate. */
async function cancelPendingExports(
  db: AnyDb,
  input: { ownerId: string; assessmentId: string; now: Date },
): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "cancelled", updatedAt: input.now })
    .where(
      and(
        eq(jobs.ownerId, input.ownerId),
        eq(jobs.type, RENDER_EXPORT_JOB_TYPE),
        inArray(jobs.status, NOT_STARTED),
        sql`${jobs.payload}->>'assessmentId' = ${input.assessmentId}`,
      ),
    );
}

/**
 * Moves one of the owner's assessments to the trash: deleted_at now, purge_after now + 30 days,
 * its exports that have not started cancelled. Nothing else changes (an approved one stays
 * approved). Unknown, foreign or already trashed ids are notFound.
 */
export async function trashAssessment(
  db: AnyDb,
  input: { ownerId: string; assessmentId: string; now: Date },
): Promise<Result<void, TrashFailure>> {
  const { ownerId, assessmentId, now } = input;
  if (!UUID.test(assessmentId)) return err("notFound");
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(assessments)
      .set({ deletedAt: now, purgeAfter: purgeAfterFrom(now) })
      .where(and(ofAssessment(ownerId, assessmentId), isNull(assessments.deletedAt)))
      .returning({ id: assessments.id });
    if (updated.length === 0) return err("notFound");
    await cancelPendingExports(tx, { ownerId, assessmentId, now });
    return ok();
  });
}

/**
 * Takes an assessment out of the trash exactly as it was. One guarded UPDATE: a purge holding the
 * row lock re-checks deleted_at and skips it, and a purged row leaves nothing to restore.
 */
export async function restoreAssessment(
  db: AnyDb,
  input: { ownerId: string; assessmentId: string },
): Promise<Result<void, TrashFailure>> {
  const { ownerId, assessmentId } = input;
  if (!UUID.test(assessmentId)) return err("notFound");
  const updated = await db
    .update(assessments)
    .set({ deletedAt: null, purgeAfter: null })
    .where(and(ofAssessment(ownerId, assessmentId), isNotNull(assessments.deletedAt)))
    .returning({ id: assessments.id });
  if (updated.length > 0) return ok();
  return err(
    (await ownsAssessment(db, ownerId, assessmentId)) ? "notInTrash" : "notFound",
  );
}

async function countOf(
  tx: AnyDb,
  table: typeof assessmentSections | typeof assessmentItems | typeof questionUsages,
  ownerId: string,
  assessmentId: string,
): Promise<number> {
  const row = (
    await tx
      .select({ n: count() })
      .from(table)
      .where(and(eq(table.ownerId, ownerId), eq(table.assessmentId, assessmentId)))
  ).at(0);
  return row?.n ?? 0;
}

interface ExportFilePlan {
  rows: number;
  prefixes: string[];
  singles: string[];
}

/**
 * What to delete from storage for the assessment, read before its rows go: each export run's own
 * prefix `exports/<ownerId>/<jobId>/` (from the export rows and from the render_export jobs, so a
 * failed run's leftovers go too), and a row without a run by its key when that key is the owner's.
 */
async function planExportFiles(
  tx: AnyDb,
  input: { ownerId: string; assessmentId: string },
): Promise<ExportFilePlan> {
  const { ownerId, assessmentId } = input;
  const rows = await tx
    .select({ id: exports.id, jobId: exports.jobId, objectKey: exports.objectKey })
    .from(exports)
    .where(and(eq(exports.ownerId, ownerId), eq(exports.assessmentId, assessmentId)));
  const runs = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.ownerId, ownerId),
        eq(jobs.type, RENDER_EXPORT_JOB_TYPE),
        sql`${jobs.payload}->>'assessmentId' = ${assessmentId}`,
      ),
    );
  const prefixes = new Set<string>();
  for (const id of [...runs.map((run) => run.id), ...rows.map((row) => row.jobId)]) {
    if (id !== null) prefixes.add(exportRunPrefix(ownerId, id));
  }
  const singles: string[] = [];
  for (const row of rows) {
    if (row.jobId !== null) continue;
    if (isOwnExportKey(ownerId, row.objectKey)) singles.push(row.objectKey);
    else {
      logger.warn(
        { module: "trash", exportId: row.id },
        "trash: export row with a key outside the owner prefix; object left alone",
      );
    }
  }
  return { rows: rows.length, prefixes: [...prefixes], singles };
}

/** Deletes the planned files; the store is asked for only when there is something to delete. */
async function deleteExportFiles(
  store: StoreSource,
  plan: ExportFilePlan,
): Promise<number> {
  if (plan.prefixes.length === 0 && plan.singles.length === 0) return 0;
  const objects = store();
  let files = 0;
  for (const prefix of plan.prefixes) files += await objects.deletePrefix(prefix);
  for (const key of plan.singles) {
    await objects.delete(key);
    files += 1;
  }
  return files;
}

/**
 * Deletes one trashed assessment in one transaction. The row is locked first and the guard (in
 * the trash; past purge_after when `expiredBy` is given; this owner when `ownerId` is given) is
 * checked under that lock, so a restore that committed first wins. The rows and the deletion_log
 * entry are written before the export files go (see the file comment). Returns the counts, or null
 * when the guard did not hold.
 */
export async function purgeAssessment(
  db: AnyDb,
  store: StoreSource,
  input: { assessmentId: string; ownerId?: string; expiredBy?: Date; now: Date },
): Promise<AssessmentPurgeCounts | null> {
  const { assessmentId, now } = input;
  if (!UUID.test(assessmentId)) return null;
  return db.transaction(async (tx) => {
    const locked = (
      await tx
        .select({ ownerId: assessments.ownerId })
        .from(assessments)
        .where(
          and(
            eq(assessments.id, assessmentId),
            isNotNull(assessments.deletedAt),
            input.ownerId === undefined
              ? undefined
              : eq(assessments.ownerId, input.ownerId),
            input.expiredBy === undefined
              ? undefined
              : lte(assessments.purgeAfter, input.expiredBy),
          ),
        )
        .for("update")
    ).at(0);
    if (!locked) return null;
    const { ownerId } = locked;

    await cancelPendingExports(tx, { ownerId, assessmentId, now });
    const sections = await countOf(tx, assessmentSections, ownerId, assessmentId);
    const items = await countOf(tx, assessmentItems, ownerId, assessmentId);
    const usages = await countOf(tx, questionUsages, ownerId, assessmentId);
    const plan = await planExportFiles(tx, { ownerId, assessmentId });

    // Database first: the cascade takes the sections, items, export rows and usage.
    await tx.delete(assessments).where(ofAssessment(ownerId, assessmentId));
    await tx.insert(deletionLog).values({
      ownerId,
      entity: DELETION_ENTITY_ASSESSMENT,
      entityId: assessmentId,
      counts: {
        assessments: 1,
        sections,
        items,
        exports: plan.rows,
        exportRuns: plan.prefixes.length,
        usages,
      },
      deletedAt: now,
    });
    // Storage last: a failure here rolls the rows above back.
    const exportFiles = await deleteExportFiles(store, plan);
    return { sections, items, exports: plan.rows, exportFiles, usages };
  });
}

/** The teacher's "delete for good" of one trashed assessment; one not in the trash is refused. */
export async function deleteAssessmentPermanently(
  db: AnyDb,
  store: StoreSource,
  input: { ownerId: string; assessmentId: string; now: Date },
): Promise<Result<AssessmentPurgeCounts, TrashFailure>> {
  const { ownerId, assessmentId, now } = input;
  const counts = await purgeAssessment(db, store, { assessmentId, ownerId, now });
  if (counts) return ok(counts);
  return err(
    (await ownsAssessment(db, ownerId, assessmentId)) ? "notInTrash" : "notFound",
  );
}

/**
 * Deletes every trashed assessment of every owner whose purge_after is at or before `now`, each in
 * its own guarded transaction (a savepoint inside the daily run). One that fails (storage, the
 * database) is rolled back whole, logged by id with the error name and code only, counted in
 * `failed` and retried the next day; it never stops the others. Idempotent.
 */
export async function purgeExpiredAssessments(
  db: AnyDb,
  store: StoreSource,
  now: Date,
  options: { outOfTime?: () => boolean; skip?: Set<string> } = {},
): Promise<{ purged: number; failed: number }> {
  const candidates = await db
    .select({ id: assessments.id })
    .from(assessments)
    .where(and(isNotNull(assessments.deletedAt), lte(assessments.purgeAfter, now)))
    .orderBy(asc(assessments.purgeAfter), asc(assessments.id))
    .limit(PURGE_BATCH);
  let purged = 0;
  let failed = 0;
  for (const { id } of candidates) {
    // A row that already failed in this run is not tried again before the others (R31).
    if (options.skip?.has(id)) continue;
    // The run's time budget is spent: the rest waits for the next run (nothing failed).
    if (options.outOfTime?.()) break;
    try {
      const counts = await purgeAssessment(db, store, {
        assessmentId: id,
        expiredBy: now,
        now,
      });
      if (counts) purged += 1;
    } catch (error) {
      failed += 1;
      options.skip?.add(id);
      logger.error(
        { module: "trash", assessmentId: id, err: safeErrorSummary(error) },
        "trash: could not purge an assessment",
      );
    }
  }
  return { purged, failed };
}

export interface TrashedAssessment {
  assessmentId: string;
  title: string;
  approved: boolean;
  sectionCount: number;
  itemCount: number;
  /** Export rows: stored files of finished runs. */
  exportCount: number;
  usageCount: number;
  deletedAt: string;
  purgeAfter: string;
  daysLeft: number;
}

/** The owner's trashed assessments, most recently deleted first, with what a delete takes. */
export async function listTrashedAssessments(
  db: AnyDb,
  input: { ownerId: string; now: Date },
): Promise<TrashedAssessment[]> {
  const { ownerId, now } = input;
  const rows = await db
    .select({
      id: assessments.id,
      title: assessments.title,
      status: assessments.status,
      deletedAt: assessments.deletedAt,
      purgeAfter: assessments.purgeAfter,
    })
    .from(assessments)
    .where(and(eq(assessments.ownerId, ownerId), isNotNull(assessments.deletedAt)))
    .orderBy(desc(assessments.deletedAt), asc(assessments.id));
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const tally = async (
    table:
      | typeof assessmentSections
      | typeof assessmentItems
      | typeof exports
      | typeof questionUsages,
  ) =>
    new Map(
      (
        await db
          .select({ id: table.assessmentId, n: count() })
          .from(table)
          .where(and(eq(table.ownerId, ownerId), inArray(table.assessmentId, ids)))
          .groupBy(table.assessmentId)
      ).map((row) => [row.id, row.n]),
    );
  const sections = await tally(assessmentSections);
  const items = await tally(assessmentItems);
  const exportRows = await tally(exports);
  const usages = await tally(questionUsages);
  return rows.flatMap((row) => {
    if (!row.deletedAt || !row.purgeAfter) return [];
    return [
      {
        assessmentId: row.id,
        title: row.title,
        approved: row.status === "approved",
        sectionCount: sections.get(row.id) ?? 0,
        itemCount: items.get(row.id) ?? 0,
        exportCount: exportRows.get(row.id) ?? 0,
        usageCount: usages.get(row.id) ?? 0,
        deletedAt: row.deletedAt.toISOString(),
        purgeAfter: row.purgeAfter.toISOString(),
        daysLeft: daysLeft(row.purgeAfter, now),
      },
    ];
  });
}
