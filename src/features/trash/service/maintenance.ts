import "server-only";
import { getDb } from "@/lib/db/runtime";
import { MIN_STEP_MS, stepBudgetMs, type StepReport } from "@/lib/jobs/tick";
import { logger } from "@/lib/logger";
import { getObjectStore } from "@/lib/storage";
import { safeErrorSummary } from "./error-summary";
import { purgeTrashOncePerDay, TRASH_PURGE_BUDGET_MS } from "./purge";

/**
 * The trash housekeeping of the daily jobs run (/api/jobs/run): deletes the assessments,
 * templates and questions whose 30 days in the trash are over (with their stored files), at most
 * once per Asia/Jakarta day. Never throws: a failure is logged and reported in the run's record;
 * a run that failed before claiming the day leaves it unclaimed, so a manual run can try again.
 */
export async function purgeTrash(
  now: Date = new Date(),
  remainingMs?: number,
): Promise<StepReport> {
  const report: StepReport = {};
  const budgetMs = stepBudgetMs(TRASH_PURGE_BUDGET_MS, remainingMs);
  // Never claim the day without a usable budget: the next run (or tomorrow's) purges.
  if (budgetMs < MIN_STEP_MS) return { backlogLeft: true };
  try {
    const result = await purgeTrashOncePerDay(getDb(), now, getObjectStore, {
      budgetMs,
      onBacklog: () => {
        report.backlogLeft = true;
      },
    });
    if (result) {
      logger.info(
        { module: "trash", purged: result.purged, failed: result.failed },
        "trash: purged what had been in the trash for 30 days",
      );
    }
  } catch (error) {
    logger.error(
      { module: "trash", err: safeErrorSummary(error) },
      "trash: the daily purge failed",
    );
    report.failed = true;
  }
  return report;
}
