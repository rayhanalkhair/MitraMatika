import "server-only";
import { safeErrorSummary } from "@/lib/db/error-summary";
import { getDb } from "@/lib/db/runtime";
import type { StepReport } from "@/lib/jobs/tick";
import { logger } from "@/lib/logger";
import { settleStrandedApprovals } from "./regenerate";

/**
 * The regeneration housekeeping of the daily jobs run (/api/jobs/run): settles the approval of
 * banked questions whose regeneration job ended without settling it, e.g. a run killed by the
 * function timeout or a lease that expired on the last attempt (R19). Never throws: a failure is
 * logged and reported in the run's record.
 */
export async function settleStrandedRegenerations(
  now: Date = new Date(),
): Promise<StepReport> {
  try {
    const settled = await settleStrandedApprovals(getDb(), now);
    if (settled > 0) {
      logger.info(
        { module: "generation", settled },
        "generation: settled approvals left by ended regenerations",
      );
    }
  } catch (error) {
    logger.error(
      { module: "generation", err: safeErrorSummary(error) },
      "generation: settling ended regenerations failed",
    );
    return { failed: true };
  }
  return {};
}
