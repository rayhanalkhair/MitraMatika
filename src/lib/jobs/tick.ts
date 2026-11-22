// The daily jobs run (/api/jobs/run, called by Vercel Cron once a day; manual runs and the in-app
// kicks also start runners): housekeeping first, then the job runner, all inside one function
// invocation of at most 300 s (Vercel Hobby's maximum). The budget is measured from the request:
// whatever the housekeeping took is subtracted from the runner's budget, so the last job a runner
// starts (an export needs 120 s of it, runner.ts/export-job.ts) still ends well inside the
// function limit. No step is STARTED once HOUSEKEEPING_CUTOFF_MS have passed (it is reported
// skipped and runs on the next daily run), and each capped step (the backfill, the purges and the
// sweeps) takes no new batch or row after its own cap or the cutoff, whichever comes first
// (stepBudgetMs). Only one bounded store call may still be in flight past the cutoff (at most 45 s,
// the trash purge's), so the runner gets at least about 240 - 120 - 45 = 75 s, usually about
// 120 s. The two uncapped database steps (settling regenerations, 200 rows; pruning accounts, 500
// users) are single bounded statements that run first. A step that throws is logged and the next
// one runs; a runner that throws is logged by name and recorded. With less than MIN_RUNNER_MS
// left, no job runs this time.
import "server-only";
import { logger } from "@/lib/logger";
import type { RunSummary } from "./runner";

/** The whole run, from the request to the runner's deadline. */
export const TICK_BUDGET_MS = 240_000;
/** A runner with less than this left is not started. */
export const MIN_RUNNER_MS = 30_000;
/** No housekeeping step is started once this long has passed since the request. */
export const HOUSEKEEPING_CUTOFF_MS = 120_000;
/**
 * A step is started only with at least this long left before the cutoff, so no step starts with
 * a tiny or zero budget (one that claims something, like the trash purge's day, could then do
 * nothing with it). A step not started is reported skipped, with work left for the next run.
 */
export const MIN_STEP_MS = 5_000;

export type StepName =
  | "settleRegenerations"
  | "pruneAccounts"
  | "backfillSearchText"
  | "purgeTrash"
  | "purgeExports"
  | "sweepMaterials"
  | "sweepSolver";

/** What a step says about itself; every step catches its own errors and may report them here. */
export interface StepReport {
  /** The step stopped on its time budget with work left for the next run (full batches are not reported). */
  backlogLeft?: boolean;
  /** The step's work failed (already logged by the step). */
  failed?: boolean;
}

export interface HousekeepingStep {
  name: StepName;
  /** `budgetMs`: the time left before the cutoff when the step starts. */
  run: (budgetMs: number) => Promise<StepReport>;
}

/**
 * A step's own time budget inside the run: its cap, or the time left before the cutoff when
 * that is shorter (never negative). So a step started just before the cutoff takes no new row
 * after it; only one bounded store call may still be in flight.
 */
export function stepBudgetMs(
  capMs: number,
  remainingMs = Number.POSITIVE_INFINITY,
): number {
  return Math.max(0, Math.min(capMs, remainingMs));
}

export interface StepResult {
  name: StepName;
  outcome: "ran" | "failed" | "skipped";
  ms: number;
  backlogLeft?: boolean;
}

export interface TickResult {
  steps: StepResult[];
  /** The runner's summary; null when it was not started or failed. */
  jobs: RunSummary | null;
  /** The name of the error the runner threw (never its message); absent when it did not throw. */
  jobsError?: string;
  /** The budget the runner got (or would have got). */
  budgetMs: number;
}

export interface TickInput {
  /** When the request came in (the clock's value). */
  startedAt: number;
  housekeeping: HousekeepingStep[];
  runJobs: (budgetMs: number) => Promise<RunSummary>;
  clock?: () => number;
}

/** Runs the housekeeping up to the cutoff, then the jobs with the time left. */
export async function runTick(input: TickInput): Promise<TickResult> {
  const clock = input.clock ?? Date.now;
  const steps: StepResult[] = [];
  for (const step of input.housekeeping) {
    const begin = clock();
    const remainingMs = HOUSEKEEPING_CUTOFF_MS - (begin - input.startedAt);
    if (remainingMs < MIN_STEP_MS) {
      steps.push({ name: step.name, outcome: "skipped", ms: 0, backlogLeft: true });
      continue;
    }
    let report: StepReport = {};
    let threw = false;
    try {
      report = await step.run(remainingMs);
    } catch (error) {
      threw = true;
      logger.error(
        {
          module: "jobs",
          step: step.name,
          err: error instanceof Error ? error.name : typeof error,
        },
        "jobs: a housekeeping step failed",
      );
    }
    const result: StepResult = {
      name: step.name,
      outcome: threw || report.failed ? "failed" : "ran",
      ms: Math.max(0, Math.round(clock() - begin)),
    };
    if (report.backlogLeft) result.backlogLeft = true;
    steps.push(result);
  }
  const skipped = steps.filter((s) => s.outcome === "skipped").map((s) => s.name);
  if (skipped.length > 0) {
    logger.warn(
      { module: "jobs", skipped },
      "jobs: housekeeping steps skipped after the cutoff; they run on the next daily run",
    );
  }
  const elapsedMs = clock() - input.startedAt;
  const budgetMs = TICK_BUDGET_MS - elapsedMs;
  if (budgetMs < MIN_RUNNER_MS) {
    logger.warn(
      { module: "jobs", elapsedMs, budgetMs },
      "jobs: housekeeping used the run's budget; the jobs run on the next run",
    );
    return { steps, jobs: null, budgetMs };
  }
  try {
    return { steps, jobs: await input.runJobs(budgetMs), budgetMs };
  } catch (error) {
    // The run's record must still be written with the steps that finished (the owner's only
    // evidence on Hobby); the error's name only, never its message.
    const name = error instanceof Error ? error.name : typeof error;
    logger.error({ module: "jobs", err: name }, "jobs: the job runner failed");
    return { steps, jobs: null, jobsError: name, budgetMs };
  }
}
