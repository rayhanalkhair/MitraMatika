// The expiry purge of exported files: every daily jobs run (not a jobs row, like purge_trash,
// R14) deletes the stored files whose 7 days are over, then their rows. A file goes up to a day
// after its expiry (the download route already answers 410 from the expiry on; the R2 `exports/`
// 8-day lifecycle rule is the backstop). No daily marker or advisory lock is needed: each step is
// idempotent (deleting a gone object or row is a no-op), so two overlapping runs do no harm.
// Failures are isolated per row (R17): a row whose object cannot be deleted stays and is retried
// on the next run; the others go on. Bounded for the daily run's budget (I5): every store call by
// EXPORT_STORE_CALL_TIMEOUT_MS, and no new row is taken after EXPORT_PURGE_BUDGET_MS (the rest
// goes on the next run, reported as a backlog in the run's record).
import "server-only";
import { and, asc, eq, lte } from "drizzle-orm";
import type { AssessmentDb } from "@/features/assessments";
import { safeErrorSummary } from "@/lib/db/error-summary";
import { getDb } from "@/lib/db/runtime";
import { exports } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { stepBudgetMs, type StepReport } from "@/lib/jobs/tick";
import { getObjectStore } from "@/lib/storage";
import { boundObjectStore } from "@/lib/storage/bounded";
import type { ObjectStore } from "@/lib/storage/types";
import { isOwnExportKey } from "./file-names";

// One run deletes at most this many files; the rest go on the next run.
const PURGE_BATCH = 500;
/** One store call of the expiry purge may take at most this long (then that row fails). */
export const EXPORT_STORE_CALL_TIMEOUT_MS = 15_000;
/** No new row is taken after this long; one call may still be in flight. */
export const EXPORT_PURGE_BUDGET_MS = 30_000;

/**
 * Deletes the object and then the row of every export whose expires_at is at or before `now`
 * (all owners, service connection). A key that is not a safe key under the row owner's export
 * prefix is never sent to storage (the row goes, the object is left alone and logged).
 */
export async function purgeExpiredExports(
  db: AssessmentDb,
  rawStore: ObjectStore,
  now: Date,
  options: {
    budgetMs?: number;
    clock?: () => number;
    storeTimeoutMs?: number;
    /** Called when the budget stopped the purge with rows left. */
    onBacklog?: () => void;
  } = {},
): Promise<{ purged: number; failed: number }> {
  const clock = options.clock ?? Date.now;
  const started = clock();
  const budgetMs = options.budgetMs ?? EXPORT_PURGE_BUDGET_MS;
  const store = boundObjectStore(
    rawStore,
    options.storeTimeoutMs ?? EXPORT_STORE_CALL_TIMEOUT_MS,
  );
  const expired = await db
    .select({ id: exports.id, ownerId: exports.ownerId, objectKey: exports.objectKey })
    .from(exports)
    .where(lte(exports.expiresAt, now))
    .orderBy(asc(exports.expiresAt), asc(exports.id))
    .limit(PURGE_BATCH);
  let purged = 0;
  let failed = 0;
  for (const row of expired) {
    // The budget is spent: the rest goes on the next run (nothing failed).
    if (clock() - started >= budgetMs) {
      options.onBacklog?.();
      break;
    }
    try {
      if (isOwnExportKey(row.ownerId, row.objectKey)) {
        await store.delete(row.objectKey);
      } else {
        logger.warn(
          { module: "export", exportId: row.id },
          "export: expired row with a key outside the owner prefix; object left alone",
        );
      }
      // Still expired and still this owner's: a row that changed meanwhile stays.
      await db
        .delete(exports)
        .where(
          and(
            eq(exports.id, row.id),
            eq(exports.ownerId, row.ownerId),
            lte(exports.expiresAt, now),
          ),
        );
      purged += 1;
    } catch (error) {
      failed += 1;
      logger.error(
        { module: "export", exportId: row.id, err: safeErrorSummary(error) },
        "export: could not purge an expired export",
      );
    }
  }
  return { purged, failed };
}

/**
 * The daily run's step. Never throws: a failure is logged, reported in the run's record, and the
 * next run tries again.
 */
export async function purgeExports(
  now: Date = new Date(),
  remainingMs?: number,
): Promise<StepReport> {
  const report: StepReport = {};
  try {
    const result = await purgeExpiredExports(getDb(), getObjectStore(), now, {
      budgetMs: stepBudgetMs(EXPORT_PURGE_BUDGET_MS, remainingMs),
      onBacklog: () => {
        report.backlogLeft = true;
      },
    });
    if (result.purged > 0 || result.failed > 0) {
      logger.info(
        { module: "export", purged: result.purged, failed: result.failed },
        "export: purged expired exports",
      );
    }
  } catch (error) {
    logger.error(
      { module: "export", err: safeErrorSummary(error) },
      "export: the expiry purge failed",
    );
    report.failed = true;
  }
  return report;
}
