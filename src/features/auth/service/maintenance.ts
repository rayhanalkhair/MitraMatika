import "server-only";
import { getDb } from "@/lib/db/runtime";
import type { StepReport } from "@/lib/jobs/tick";
import { logger } from "@/lib/logger";
import { pruneExpiredLimitRows } from "./prune-limit-rows";
import { pruneUnverifiedUsers } from "./prune-unverified";

/**
 * The account housekeeping of the daily jobs run (/api/jobs/run): deletes unverified sign-ups
 * older than 7 days (a batch per run), then the app's limit rows that expired over a day ago.
 * Never throws: a failure is logged, reported in the run's record, and the run goes on.
 */
export async function pruneUnverifiedAccounts(
  now: Date = new Date(),
): Promise<StepReport> {
  const report: StepReport = {};
  try {
    const deleted = await pruneUnverifiedUsers(getDb(), now);
    if (deleted > 0) {
      logger.info(
        { module: "auth", deleted },
        "auth: deleted unverified accounts older than 7 days",
      );
    }
  } catch (error) {
    logger.error(
      { module: "auth", err: error },
      "auth: pruning unverified accounts failed",
    );
    report.failed = true;
  }
  try {
    await pruneExpiredLimitRows(getDb(), now);
  } catch (error) {
    logger.error(
      { module: "auth", err: error },
      "auth: pruning expired limit rows failed",
    );
    report.failed = true;
  }
  return report;
}
