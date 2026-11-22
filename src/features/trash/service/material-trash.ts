// The trash for learning materials and their folders (decision 3 of the materials plan). Same shape
// as the template trash: writes on the service connection naming owner_id in every statement, the
// lists under runAsUser (the page).
//
// A trashed material is invisible to the library (not listed, searched, opened or edited, and its
// jobs that have not started are cancelled). Restoring brings it back as it was; one whose folder
// is in the trash (or gone) comes back at the top level, and one whose text was still being read
// gets its ingestion queued again (the idempotent page insert makes resuming safe, R15).
//
// Deleting for good, in one transaction under the row lock: first every database write (the
// citations of banked questions lose their material link and stored excerpt but keep their anchor,
// so the question keeps its content and shows that the source was deleted (MAT-11); the material
// row, which cascades to its pages and sections; the deletion_log entry), then the material's whole
// own prefix in the store `materials/<ownerId>/<materialId>/` (the source file and the page images
// under `pages/`), last before the commit. A storage failure rolls the rows back and the delete is
// retried; a file is never orphaned by a half-done delete.
//
// Folders: a folder is moved to the trash only when it holds no live material and no live subfolder
// (the teacher moves or trashes those first: nothing disappears from the library by surprise). A
// restored folder whose parent is in the trash (or gone) comes back at the top level. Deleting a
// folder for good keeps whatever trashed subfolders and materials it held: they move to the top
// level and keep their own 30 days.
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
  deletionLog,
  folders,
  jobs,
  materialPages,
  materials,
  materialSections,
  questionSources,
} from "@/lib/db/schema";
import type { AnyDb } from "@/features/generation";
import { createJobQueue } from "@/lib/jobs/queue";
import { logger } from "@/lib/logger";
import { err, ok, type Result } from "@/lib/result";
import type { StoreSource } from "./assessment-trash";
import { safeErrorSummary } from "./error-summary";
import { daysLeft, purgeAfterFrom, type TrashFailure } from "./retention";
import {
  INGEST_MATERIAL_JOB_TYPE,
  materialPrefix,
  OCR_PAGES_JOB_TYPE,
  PROPOSE_STRUCTURE_JOB_TYPE,
} from "./storage-keys";

export const DELETION_ENTITY_MATERIAL = "material";
export const DELETION_ENTITY_FOLDER = "folder";
// One purge run deletes at most this many of each; the rest go the next day.
const PURGE_BATCH = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_STARTED = ["queued", "deferred"];
const LIVE_JOB = ["queued", "running", "deferred"];
const INGEST_MAX_ATTEMPTS = 3;

/** A folder that still holds live materials or subfolders is not moved to the trash. */
export type FolderTrashFailure = TrashFailure | "notEmpty";

export interface MaterialPurgeCounts {
  pages: number;
  sections: number;
  /** Citations of questions that lost their link to the material (MAT-11). */
  citations: number;
  /** Objects removed under the material's own prefix. */
  files: number;
}

export interface FolderPurgeCounts {
  /** Trashed subfolders moved to the top level. */
  subfolders: number;
  /** Trashed materials moved to the top level. */
  materials: number;
}

const ofMaterial = (ownerId: string, materialId: string) =>
  and(eq(materials.id, materialId), eq(materials.ownerId, ownerId));
const ofFolder = (ownerId: string, folderId: string) =>
  and(eq(folders.id, folderId), eq(folders.ownerId, ownerId));

async function ownsMaterial(db: AnyDb, ownerId: string, materialId: string) {
  const rows = await db
    .select({ id: materials.id })
    .from(materials)
    .where(ofMaterial(ownerId, materialId))
    .limit(1);
  return rows.length > 0;
}

async function ownsFolder(db: AnyDb, ownerId: string, folderId: string) {
  const rows = await db
    .select({ id: folders.id })
    .from(folders)
    .where(ofFolder(ownerId, folderId))
    .limit(1);
  return rows.length > 0;
}

/** Cancels the material's jobs that have not started (ingestion, structure proposal). */
async function cancelMaterialJobs(
  db: AnyDb,
  input: { ownerId: string; materialId: string; now: Date },
): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "cancelled", updatedAt: input.now })
    .where(
      and(
        eq(jobs.ownerId, input.ownerId),
        inArray(jobs.type, [
          INGEST_MATERIAL_JOB_TYPE,
          PROPOSE_STRUCTURE_JOB_TYPE,
          OCR_PAGES_JOB_TYPE,
        ]),
        inArray(jobs.status, NOT_STARTED),
        sql`${jobs.payload}->>'materialId' = ${input.materialId}`,
      ),
    );
}

/**
 * Moves one of the owner's materials to the trash for 30 days and cancels its jobs that have not
 * started (a running one finds it trashed and stops); pages queued for OCR end as `failed`.
 * Unknown, foreign or already trashed ids are notFound.
 */
export async function trashMaterial(
  db: AnyDb,
  input: { ownerId: string; materialId: string; now: Date },
): Promise<Result<void, TrashFailure>> {
  const { ownerId, materialId, now } = input;
  if (!UUID.test(materialId)) return err("notFound");
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(materials)
      .set({ deletedAt: now, purgeAfter: purgeAfterFrom(now) })
      .where(and(ofMaterial(ownerId, materialId), isNull(materials.deletedAt)))
      .returning({ id: materials.id });
    if (updated.length === 0) return err<TrashFailure>("notFound");
    await cancelMaterialJobs(tx, { ownerId, materialId, now });
    // Their OCR job is cancelled (or stops at its next page): the pages can be sent again.
    await tx
      .update(materialPages)
      .set({ ocrStatus: "failed", updatedAt: now })
      .where(
        and(
          eq(materialPages.materialId, materialId),
          eq(materialPages.ownerId, ownerId),
          eq(materialPages.ocrStatus, "queued"),
        ),
      );
    return ok();
  });
}

/**
 * Takes a material out of the trash. Its folder is kept when it is still live, else the material
 * comes back at the top level; a material whose text was not fully read (`uploaded` or
 * `processing`) gets its ingestion queued again unless a job for it is still live (`requeued`).
 */
export async function restoreMaterial(
  db: AnyDb,
  input: { ownerId: string; materialId: string; now: Date },
): Promise<Result<{ requeued: boolean }, TrashFailure>> {
  const { ownerId, materialId, now } = input;
  if (!UUID.test(materialId)) return err("notFound");
  const restored = await db.transaction(async (tx) => {
    const row = (
      await tx
        .select({ status: materials.status, folderId: materials.folderId })
        .from(materials)
        .where(and(ofMaterial(ownerId, materialId), isNotNull(materials.deletedAt)))
        .for("update")
    ).at(0);
    if (!row) return null;
    let folderId = row.folderId;
    if (folderId !== null) {
      const folder = await tx
        .select({ id: folders.id })
        .from(folders)
        .where(and(ofFolder(ownerId, folderId), isNull(folders.deletedAt)))
        .for("share");
      if (folder.length === 0) folderId = null;
    }
    await tx
      .update(materials)
      .set({ deletedAt: null, purgeAfter: null, folderId })
      .where(ofMaterial(ownerId, materialId));
    if (row.status !== "uploaded" && row.status !== "processing") {
      return { requeued: false };
    }
    const live = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.ownerId, ownerId),
          eq(jobs.type, INGEST_MATERIAL_JOB_TYPE),
          inArray(jobs.status, LIVE_JOB),
          sql`${jobs.payload}->>'materialId' = ${materialId}`,
        ),
      )
      .limit(1);
    if (live.length > 0) return { requeued: false };
    await createJobQueue(tx, () => now).enqueue({
      ownerId,
      type: INGEST_MATERIAL_JOB_TYPE,
      payload: { materialId },
      runAfter: now,
      maxAttempts: INGEST_MAX_ATTEMPTS,
    });
    return { requeued: true };
  });
  if (restored) return ok(restored);
  return err((await ownsMaterial(db, ownerId, materialId)) ? "notInTrash" : "notFound");
}

/**
 * Deletes one trashed material in one transaction, guarded under the row lock (in the trash; past
 * purge_after when `expiredBy` is given; this owner when `ownerId` is given). Returns the counts,
 * or null when the guard did not hold (nothing written).
 */
export async function purgeMaterial(
  db: AnyDb,
  store: StoreSource,
  input: { materialId: string; ownerId?: string; expiredBy?: Date; now: Date },
): Promise<MaterialPurgeCounts | null> {
  const { materialId, now } = input;
  if (!UUID.test(materialId)) return null;
  return db.transaction(async (tx) => {
    const locked = (
      await tx
        .select({ ownerId: materials.ownerId })
        .from(materials)
        .where(
          and(
            eq(materials.id, materialId),
            isNotNull(materials.deletedAt),
            input.ownerId === undefined
              ? undefined
              : eq(materials.ownerId, input.ownerId),
            input.expiredBy === undefined
              ? undefined
              : lte(materials.purgeAfter, input.expiredBy),
          ),
        )
        .for("update")
    ).at(0);
    if (!locked) return null;
    const { ownerId } = locked;

    const [pages] = await tx
      .select({ n: count() })
      .from(materialPages)
      .where(
        and(eq(materialPages.materialId, materialId), eq(materialPages.ownerId, ownerId)),
      );
    const [sections] = await tx
      .select({ n: count() })
      .from(materialSections)
      .where(
        and(
          eq(materialSections.materialId, materialId),
          eq(materialSections.ownerId, ownerId),
        ),
      );
    await cancelMaterialJobs(tx, { ownerId, materialId, now });
    // MAT-11: the question keeps its content and the anchor ("hal. 12"); the link to the material
    // and the stored excerpt of its text go (a trigger clears the page and section links).
    const citations = await tx
      .update(questionSources)
      .set({ materialId: null, excerpt: null })
      .where(
        and(
          eq(questionSources.materialId, materialId),
          eq(questionSources.ownerId, ownerId),
        ),
      )
      .returning({ id: questionSources.id });
    // The cascade takes the pages and sections.
    await tx.delete(materials).where(ofMaterial(ownerId, materialId));
    const rows = { pages: pages.n, sections: sections.n, citations: citations.length };
    await tx.insert(deletionLog).values({
      ownerId,
      entity: DELETION_ENTITY_MATERIAL,
      entityId: materialId,
      counts: { materials: 1, ...rows },
      deletedAt: now,
    });
    // Storage last, the material's whole own prefix whatever its columns say (R13): a database
    // failure happens before any file is touched, a storage failure rolls the rows back.
    const files = await store().deletePrefix(materialPrefix(ownerId, materialId));
    return { ...rows, files };
  });
}

/** The teacher's "delete for good": refused when not in the trash. */
export async function deleteMaterialPermanently(
  db: AnyDb,
  store: StoreSource,
  input: { ownerId: string; materialId: string; now: Date },
): Promise<Result<MaterialPurgeCounts, TrashFailure>> {
  const { ownerId, materialId, now } = input;
  const outcome = await purgeMaterial(db, store, { materialId, ownerId, now });
  if (outcome) return ok(outcome);
  return err((await ownsMaterial(db, ownerId, materialId)) ? "notInTrash" : "notFound");
}

/**
 * Deletes every expired trashed material of every owner, each in its own guarded transaction: one
 * that fails is rolled back, logged and retried the next day. Idempotent.
 */
export async function purgeExpiredMaterials(
  db: AnyDb,
  store: StoreSource,
  now: Date,
  options: { batch?: number; outOfTime?: () => boolean; skip?: Set<string> } = {},
): Promise<{ purged: number; failed: number }> {
  const candidates = await db
    .select({ id: materials.id })
    .from(materials)
    .where(and(isNotNull(materials.deletedAt), lte(materials.purgeAfter, now)))
    .orderBy(asc(materials.purgeAfter), asc(materials.id))
    .limit(options.batch ?? PURGE_BATCH);
  let purged = 0;
  let failed = 0;
  for (const { id } of candidates) {
    // A row that already failed in this run is not tried again before the others (R31).
    if (options.skip?.has(id)) continue;
    if (options.outOfTime?.()) break;
    try {
      const outcome = await purgeMaterial(db, store, {
        materialId: id,
        expiredBy: now,
        now,
      });
      if (outcome) purged += 1;
    } catch (error) {
      failed += 1;
      options.skip?.add(id);
      logger.error(
        { module: "trash", materialId: id, err: safeErrorSummary(error) },
        "trash: could not purge a material",
      );
    }
  }
  return { purged, failed };
}

export interface TrashedMaterial {
  materialId: string;
  title: string;
  kind: string;
  pageCount: number | null;
  sectionCount: number;
  /** Citations in banked questions that will show "source deleted" after a permanent delete. */
  citationCount: number;
  deletedAt: string;
  purgeAfter: string;
  daysLeft: number;
}

/** The owner's trashed materials, most recently deleted first. */
export async function listTrashedMaterials(
  db: AnyDb,
  input: { ownerId: string; now: Date },
): Promise<TrashedMaterial[]> {
  const { ownerId, now } = input;
  const rows = await db
    .select({
      id: materials.id,
      title: materials.title,
      kind: materials.kind,
      pageCount: materials.pageCount,
      deletedAt: materials.deletedAt,
      purgeAfter: materials.purgeAfter,
    })
    .from(materials)
    .where(and(eq(materials.ownerId, ownerId), isNotNull(materials.deletedAt)))
    .orderBy(desc(materials.deletedAt), asc(materials.id));
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const sections = await db
    .select({ materialId: materialSections.materialId, n: count() })
    .from(materialSections)
    .where(
      and(
        eq(materialSections.ownerId, ownerId),
        inArray(materialSections.materialId, ids),
      ),
    )
    .groupBy(materialSections.materialId);
  const citations = await db
    .select({ materialId: questionSources.materialId, n: count() })
    .from(questionSources)
    .where(
      and(eq(questionSources.ownerId, ownerId), inArray(questionSources.materialId, ids)),
    )
    .groupBy(questionSources.materialId);
  return rows.flatMap((row) => {
    if (!row.deletedAt || !row.purgeAfter) return [];
    return [
      {
        materialId: row.id,
        title: row.title,
        kind: row.kind,
        pageCount: row.pageCount,
        sectionCount: sections.find((s) => s.materialId === row.id)?.n ?? 0,
        citationCount: citations.find((c) => c.materialId === row.id)?.n ?? 0,
        deletedAt: row.deletedAt.toISOString(),
        purgeAfter: row.purgeAfter.toISOString(),
        daysLeft: daysLeft(row.purgeAfter, now),
      },
    ];
  });
}

/**
 * Moves one of the owner's folders to the trash for 30 days, only when it holds no live material
 * and no live subfolder (`notEmpty`). The row is locked first, so a folder created or a material
 * moved into it at the same moment either lands before (and the trash is refused) or finds it
 * trashed.
 */
export async function trashFolder(
  db: AnyDb,
  input: { ownerId: string; folderId: string; now: Date },
): Promise<Result<void, FolderTrashFailure>> {
  const { ownerId, folderId, now } = input;
  if (!UUID.test(folderId)) return err("notFound");
  return db.transaction(async (tx) => {
    const row = (
      await tx
        .select({ id: folders.id })
        .from(folders)
        .where(and(ofFolder(ownerId, folderId), isNull(folders.deletedAt)))
        .for("update")
    ).at(0);
    if (!row) return err<FolderTrashFailure>("notFound");
    const [inside] = await tx
      .select({ n: count() })
      .from(materials)
      .where(
        and(
          eq(materials.ownerId, ownerId),
          eq(materials.folderId, folderId),
          isNull(materials.deletedAt),
        ),
      );
    const [children] = await tx
      .select({ n: count() })
      .from(folders)
      .where(
        and(
          eq(folders.ownerId, ownerId),
          eq(folders.parentId, folderId),
          isNull(folders.deletedAt),
        ),
      );
    if (inside.n > 0 || children.n > 0) return err<FolderTrashFailure>("notEmpty");
    await tx
      .update(folders)
      .set({ deletedAt: now, purgeAfter: purgeAfterFrom(now) })
      .where(ofFolder(ownerId, folderId));
    return ok();
  });
}

/** Takes a folder out of the trash; at the top level when its parent is not live. */
export async function restoreFolder(
  db: AnyDb,
  input: { ownerId: string; folderId: string },
): Promise<Result<void, TrashFailure>> {
  const { ownerId, folderId } = input;
  if (!UUID.test(folderId)) return err("notFound");
  const restored = await db.transaction(async (tx) => {
    const row = (
      await tx
        .select({ parentId: folders.parentId })
        .from(folders)
        .where(and(ofFolder(ownerId, folderId), isNotNull(folders.deletedAt)))
        .for("update")
    ).at(0);
    if (!row) return false;
    let parentId = row.parentId;
    if (parentId !== null) {
      const parent = await tx
        .select({ id: folders.id })
        .from(folders)
        .where(and(ofFolder(ownerId, parentId), isNull(folders.deletedAt)))
        .for("share");
      if (parent.length === 0) parentId = null;
    }
    await tx
      .update(folders)
      .set(
        parentId === row.parentId
          ? { deletedAt: null, purgeAfter: null }
          : { deletedAt: null, purgeAfter: null, parentId },
      )
      .where(ofFolder(ownerId, folderId));
    return true;
  });
  if (restored) return ok();
  return err((await ownsFolder(db, ownerId, folderId)) ? "notInTrash" : "notFound");
}

/** Deletes one trashed folder (guarded under its row lock like purgeMaterial); null if not held. */
export async function purgeFolder(
  db: AnyDb,
  input: { folderId: string; ownerId?: string; expiredBy?: Date; now: Date },
): Promise<FolderPurgeCounts | null> {
  const { folderId, now } = input;
  if (!UUID.test(folderId)) return null;
  return db.transaction(async (tx) => {
    const locked = (
      await tx
        .select({ ownerId: folders.ownerId })
        .from(folders)
        .where(
          and(
            eq(folders.id, folderId),
            isNotNull(folders.deletedAt),
            input.ownerId === undefined ? undefined : eq(folders.ownerId, input.ownerId),
            input.expiredBy === undefined
              ? undefined
              : lte(folders.purgeAfter, input.expiredBy),
          ),
        )
        .for("update")
    ).at(0);
    if (!locked) return null;
    const { ownerId } = locked;
    // Its subfolders would go with it (cascade): they move to the top level and keep their days.
    const subfolders = await tx
      .update(folders)
      .set({ parentId: null })
      .where(and(eq(folders.ownerId, ownerId), eq(folders.parentId, folderId)))
      .returning({ id: folders.id });
    const moved = await tx
      .update(materials)
      .set({ folderId: null })
      .where(and(eq(materials.ownerId, ownerId), eq(materials.folderId, folderId)))
      .returning({ id: materials.id });
    await tx.delete(folders).where(ofFolder(ownerId, folderId));
    const counts: FolderPurgeCounts = {
      subfolders: subfolders.length,
      materials: moved.length,
    };
    await tx.insert(deletionLog).values({
      ownerId,
      entity: DELETION_ENTITY_FOLDER,
      entityId: folderId,
      counts: { folders: 1, ...counts },
      deletedAt: now,
    });
    return counts;
  });
}

export async function deleteFolderPermanently(
  db: AnyDb,
  input: { ownerId: string; folderId: string; now: Date },
): Promise<Result<FolderPurgeCounts, TrashFailure>> {
  const { ownerId, folderId, now } = input;
  const outcome = await purgeFolder(db, { folderId, ownerId, now });
  if (outcome) return ok(outcome);
  return err((await ownsFolder(db, ownerId, folderId)) ? "notInTrash" : "notFound");
}

/** Deletes every expired trashed folder of every owner, each on its own. Idempotent. */
export async function purgeExpiredFolders(
  db: AnyDb,
  now: Date,
  options: { batch?: number; outOfTime?: () => boolean; skip?: Set<string> } = {},
): Promise<{ purged: number; failed: number }> {
  const candidates = await db
    .select({ id: folders.id })
    .from(folders)
    .where(and(isNotNull(folders.deletedAt), lte(folders.purgeAfter, now)))
    .orderBy(asc(folders.purgeAfter), asc(folders.id))
    .limit(options.batch ?? PURGE_BATCH);
  let purged = 0;
  let failed = 0;
  for (const { id } of candidates) {
    // A row that already failed in this run is not tried again before the others (R31).
    if (options.skip?.has(id)) continue;
    if (options.outOfTime?.()) break;
    try {
      if (await purgeFolder(db, { folderId: id, expiredBy: now, now })) purged += 1;
    } catch (error) {
      failed += 1;
      options.skip?.add(id);
      logger.error(
        { module: "trash", folderId: id, err: safeErrorSummary(error) },
        "trash: could not purge a folder",
      );
    }
  }
  return { purged, failed };
}

export interface TrashedFolder {
  folderId: string;
  name: string;
  deletedAt: string;
  purgeAfter: string;
  daysLeft: number;
}

/** The owner's trashed folders, most recently deleted first. */
export async function listTrashedFolders(
  db: AnyDb,
  input: { ownerId: string; now: Date },
): Promise<TrashedFolder[]> {
  const rows = await db
    .select({
      id: folders.id,
      name: folders.name,
      deletedAt: folders.deletedAt,
      purgeAfter: folders.purgeAfter,
    })
    .from(folders)
    .where(and(eq(folders.ownerId, input.ownerId), isNotNull(folders.deletedAt)))
    .orderBy(desc(folders.deletedAt), asc(folders.id));
  return rows.flatMap((row) =>
    row.deletedAt && row.purgeAfter
      ? [
          {
            folderId: row.id,
            name: row.name,
            deletedAt: row.deletedAt.toISOString(),
            purgeAfter: row.purgeAfter.toISOString(),
            daysLeft: daysLeft(row.purgeAfter, input.now),
          },
        ]
      : [],
  );
}
