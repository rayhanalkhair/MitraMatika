import "server-only";
import { safeErrorSummary } from "@/lib/db/error-summary";
import { getDb } from "@/lib/db/runtime";
import { stepBudgetMs, type StepReport } from "@/lib/jobs/tick";
import { logger } from "@/lib/logger";
import { backfillSearchText } from "./backfill-search-text";

// One daily run fills at most this many batches (2 000 rows); the next run continues.
const MAX_BATCHES_PER_TICK = 10;
/** No new batch starts after this long (or after the run's cutoff, if sooner). */
export const BACKFILL_BUDGET_MS = 10_000;

/**
 * The bank housekeeping of the daily jobs run: fills the search text of questions that predate
 * the column. A no-op once none are left. Never throws: a failure is logged, reported in the
 * run's record, and the run goes on.
 */
export async function backfillBankSearchText(remainingMs?: number): Promise<StepReport> {
  const report: StepReport = {};
  const started = Date.now();
  const budgetMs = stepBudgetMs(BACKFILL_BUDGET_MS, remainingMs);
  try {
    const filled = await backfillSearchText(getDb(), {
      maxBatches: MAX_BATCHES_PER_TICK,
      outOfTime: () => Date.now() - started >= budgetMs,
      onOutOfTime: () => {
        report.backlogLeft = true;
      },
    });
    if (filled > 0) {
      logger.info(
        { module: "bank", filled },
        "bank: filled the search text of questions",
      );
    }
  } catch (error) {
    // Never the error itself: its parameters carry the normalised question text.
    logger.error(
      { module: "bank", err: safeErrorSummary(error) },
      "bank: filling the search text failed",
    );
    return { failed: true };
  }
  return report;
}
