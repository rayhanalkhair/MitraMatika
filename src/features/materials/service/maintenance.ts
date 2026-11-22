import "server-only";
// The materials' share of the daily jobs run (/api/jobs/run), each bounded in time:
//
// 1. Stuck materials (R15, Task 4 review I2): a material can be left `uploaded` or `processing`
//    for good when its ingest job ended without the handler running to the end (the function was
//    killed three times and the runner's stale-lease reclaim failed the job). A material in one of
//    those states, not trashed, untouched for STUCK_AFTER_MS and with no `ingest_material` job of
//    its owner that is queued, running or deferred, becomes `failed` (the teacher can trash it and
//    upload again). A deferred job (waiting for its parsers, R15) keeps it alive. Restoring a
//    trashed material re-queues its ingestion instead (the trash).
// 2. Expired upload reservations (R9, R13): a reservation the teacher never finalised (or
//    cancelled) keeps counting toward the caps until `expires_at`; after that, the sweep deletes
//    its staging object (only under the row owner's own `uploads/` prefix) and then the row. A
//    reservation a finalise is checking right now (a claim younger than CLAIM_TTL_MS) is left
//    alone. A failed delete keeps the row for the next run. The startUpload sweep of the same
//    owner uses the same rule; the R2 lifecycle rule on `uploads/` is the last backstop.
// 3. Stuck OCR pages (Task 6 review I2): pages still `queued` that no live `ocr_pages` job lists
//    end `failed` and go back to the daily cap (sweepStuckOcrPages in ocr-job.ts).
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { jobs, materials, materialUploads } from "@/lib/db/schema";
import { getDb } from "@/lib/db/runtime";
import { logger } from "@/lib/logger";
import { stepBudgetMs, type StepReport } from "@/lib/jobs/tick";
import { getObjectStore } from "@/lib/storage";
import { boundObjectStore } from "@/lib/storage/bounded";
import type { ObjectStore } from "@/lib/storage/types";
import { INGEST_MATERIAL_JOB } from "../schema/upload";
import { sweepStuckOcrPages } from "./ocr-job";
import { CLAIM_TTL_MS, isOwnUploadKey, type MaterialDb } from "./upload";

/** Longer than the runner's 10-minute lease and any honest step. */
export const STUCK_AFTER_MS = 30 * 60_000;
const STUCK_BATCH = 200;
const UPLOAD_BATCH = 200;
/** The whole materials housekeeping takes no new row after this long. */
export const MATERIAL_SWEEP_BUDGET_MS = 20_000;
/** One store call of the sweep may take at most this long. */
const STORE_CALL_TIMEOUT_MS = 10_000;
const LIVE_JOB = ["queued", "running", "deferred"];

function errorSummary(error: unknown) {
  const outer = error as
    { code?: unknown; cause?: { code?: unknown } } | null | undefined;
  const code = outer?.code ?? outer?.cause?.code;
  return {
    name: error instanceof Error ? error.name : typeof error,
    code: typeof code === "string" ? code : null,
  };
}

/** Marks stuck materials `failed`; returns how many. Idempotent. */
export async function sweepStuckMaterials(
  db: MaterialDb,
  now: Date,
  options: { batch?: number } = {},
): Promise<number> {
  const before = new Date(now.getTime() - STUCK_AFTER_MS);
  const liveJob = sql`exists (select 1 from ${jobs}
    where ${jobs.ownerId} = ${materials.ownerId}
      and ${jobs.type} = ${INGEST_MATERIAL_JOB}
      and ${inArray(jobs.status, LIVE_JOB)}
      and ${jobs.payload}->>'materialId' = ${materials.id}::text)`;
  const stuck = await db
    .select({ id: materials.id })
    .from(materials)
    .where(
      and(
        inArray(materials.status, ["uploaded", "processing"]),
        isNull(materials.deletedAt),
        lte(materials.updatedAt, before),
        sql`not ${liveJob}`,
      ),
    )
    .orderBy(asc(materials.updatedAt), asc(materials.id))
    .limit(options.batch ?? STUCK_BATCH);
  let failed = 0;
  for (const { id } of stuck) {
    // Each candidate on its own, under its row lock: a restore holds the same lock while it
    // queues the ingestion again, so it either finishes first (and the job check, a fresh
    // statement, sees its job) or is skipped this hour (SKIP LOCKED) and waits for us.
    const marked = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as MaterialDb;
      const row = await tx
        .select({ id: materials.id })
        .from(materials)
        .where(
          and(
            eq(materials.id, id),
            inArray(materials.status, ["uploaded", "processing"]),
            isNull(materials.deletedAt),
            lte(materials.updatedAt, before),
          ),
        )
        .for("update", { skipLocked: true });
      if (row.length === 0) return false;
      const [{ live }] = await tx
        .select({ live: sql<boolean>`${liveJob}` })
        .from(materials)
        .where(eq(materials.id, id));
      if (live) return false;
      await tx
        .update(materials)
        .set({ status: "failed", updatedAt: now })
        .where(eq(materials.id, id));
      return true;
    });
    if (marked) failed += 1;
  }
  return failed;
}

/** Deletes expired reservations with their staging objects; returns the counts. */
export async function sweepExpiredUploads(
  db: MaterialDb,
  store: ObjectStore,
  now: Date,
  options: { batch?: number; outOfTime?: () => boolean } = {},
): Promise<{ deleted: number; failed: number }> {
  const staleClaim = new Date(now.getTime() - CLAIM_TTL_MS);
  const unclaimed = or(
    isNull(materialUploads.claimedAt),
    lte(materialUploads.claimedAt, staleClaim),
  );
  const rows = await db
    .select({
      id: materialUploads.id,
      ownerId: materialUploads.ownerId,
      objectKey: materialUploads.objectKey,
    })
    .from(materialUploads)
    .where(and(lte(materialUploads.expiresAt, now), unclaimed))
    .orderBy(asc(materialUploads.expiresAt), asc(materialUploads.id))
    .limit(options.batch ?? UPLOAD_BATCH);
  let deleted = 0;
  let failed = 0;
  for (const row of rows) {
    if (options.outOfTime?.()) break;
    try {
      // Ids-only keys (R13): a row naming anything but its owner's staging prefix touches no object.
      if (isOwnUploadKey(row.ownerId, row.objectKey)) await store.delete(row.objectKey);
      else {
        logger.warn(
          { module: "materials", uploadId: row.id },
          "materials: an upload reservation names a key outside its staging prefix",
        );
      }
      const gone = await db
        .delete(materialUploads)
        .where(
          and(
            eq(materialUploads.id, row.id),
            lte(materialUploads.expiresAt, now),
            unclaimed,
          ),
        )
        .returning({ id: materialUploads.id });
      deleted += gone.length;
    } catch (error) {
      failed += 1;
      logger.error(
        { module: "materials", uploadId: row.id, err: errorSummary(error) },
        "materials: could not sweep an expired upload",
      );
    }
  }
  return { deleted, failed };
}

/**
 * The sweeps, each guarded (a failure is logged and counts nothing), the uploads within
 * MATERIAL_SWEEP_BUDGET_MS and every store call bounded. Never throws.
 */
export async function runMaterialHousekeeping(
  db: MaterialDb,
  store: () => ObjectStore,
  now: Date,
  options: {
    budgetMs?: number;
    clock?: () => number;
    /** Called when the budget stopped the upload sweep with rows left. */
    onBacklog?: () => void;
    /** Called for each sweep that failed (already logged). */
    onFailure?: () => void;
  } = {},
): Promise<{
  stuck: number;
  ocrPages: number;
  uploads: { deleted: number; failed: number };
}> {
  const clock = options.clock ?? Date.now;
  const started = clock();
  const budgetMs = options.budgetMs ?? MATERIAL_SWEEP_BUDGET_MS;
  let stuck = 0;
  let ocrPages = 0;
  let uploads = { deleted: 0, failed: 0 };
  try {
    stuck = await sweepStuckMaterials(db, now);
  } catch (error) {
    logger.error(
      { module: "materials", err: errorSummary(error) },
      "materials: the stuck-material sweep failed",
    );
    options.onFailure?.();
  }
  try {
    ocrPages = await sweepStuckOcrPages(db, now);
  } catch (error) {
    logger.error(
      { module: "materials", err: errorSummary(error) },
      "materials: the stuck OCR page sweep failed",
    );
    options.onFailure?.();
  }
  try {
    uploads = await sweepExpiredUploads(
      db,
      boundObjectStore(store(), STORE_CALL_TIMEOUT_MS),
      now,
      {
        outOfTime: () => {
          const late = clock() - started >= budgetMs;
          if (late) options.onBacklog?.();
          return late;
        },
      },
    );
  } catch (error) {
    logger.error(
      { module: "materials", err: errorSummary(error) },
      "materials: the expired-upload sweep failed",
    );
    options.onFailure?.();
  }
  return { stuck, ocrPages, uploads };
}

/** The daily run's step (service connection). Never throws; reports failures and a backlog. */
export async function sweepMaterials(
  now: Date = new Date(),
  remainingMs?: number,
): Promise<StepReport> {
  const report: StepReport = {};
  const result = await runMaterialHousekeeping(getDb(), getObjectStore, now, {
    budgetMs: stepBudgetMs(MATERIAL_SWEEP_BUDGET_MS, remainingMs),
    onBacklog: () => {
      report.backlogLeft = true;
    },
    onFailure: () => {
      report.failed = true;
    },
  });
  if (
    result.stuck > 0 ||
    result.ocrPages > 0 ||
    result.uploads.deleted > 0 ||
    result.uploads.failed > 0
  ) {
    logger.info({ module: "materials", ...result }, "materials: housekeeping done");
  }
  return report;
}
