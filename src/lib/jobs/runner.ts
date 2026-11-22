import "server-only";
import { PermanentJobError, RetryableJobError, type HandlerResult } from "./handler";
import type { JobRegistry } from "./registry";
import type {
  Claim,
  ClaimedJob,
  JobFailure,
  JobQueue,
  JobRunLog,
  JobRunOutcome,
  Progress,
} from "./types";
import { logger } from "@/lib/logger";

export const DEFAULT_BUDGET_MS = 240_000;
export const DEFAULT_LEASE_MS = 600_000;

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 900_000;

// `attempts` is the job's failure count before the failure being handled.
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_CAP_MS);
}

export interface RunSummary {
  ran: number;
  succeeded: number;
  continued: number;
  deferred: number;
  retried: number;
  failed: number;
  lostLease: number;
  reclaimed: number;
  budgetExhausted: boolean;
}

export interface FailureInfo {
  job: ClaimedJob;
  failure: JobFailure;
}

export interface RunnerOptions {
  queue: JobQueue;
  registry: JobRegistry;
  // Records one `job_runs` row per attempt. Optional and best effort (see JobRunLog).
  runs?: JobRunLog;
  // `now` and the queue's clock must be the same source (production uses the real clock for both);
  // otherwise the budget deadline and the retry/defer times are measured on different clocks.
  now?: () => Date;
  budgetMs?: number;
  leaseMs?: number;
  // Called once for a job that has failed for good (never for a retried failure).
  onFailure?: (info: FailureInfo) => Promise<void>;
  // Whether this owner may still have work run (the account is approved). Absent means everyone
  // may. Asked before a job's handler runs, once per owner per invocation; false fails the job for
  // good as `account_not_approved`, a throw re-queues it (the owner cannot be told apart from an
  // outage, so the job is neither run nor dropped).
  canRun?: (ownerId: string) => Promise<boolean>;
}

const NOT_APPROVED_FAILURE: JobFailure = {
  code: "account_not_approved",
  message: "Akun belum disetujui.",
};
const APPROVAL_CHECK_FAILURE: JobFailure = {
  code: "approval_check_failed",
  message: "Persetujuan akun belum bisa diperiksa.",
};

function describeFailure(error: unknown): JobFailure {
  if (error instanceof PermanentJobError || error instanceof RetryableJobError)
    return { code: error.code, message: error.message };
  return {
    code: "handler_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Handlers are plain async functions, so the runner checks what they return before acting on it.
 */
export function isValidHandlerResult(value: unknown): value is HandlerResult {
  if (!isObject(value)) return false;
  switch (value.kind) {
    case "done":
      return true;
    case "continue":
      return isObject(value.progress);
    case "defer":
      return value.runAfter instanceof Date && !Number.isNaN(value.runAfter.getTime());
    default:
      return false;
  }
}

type Outcome = { result: HandlerResult } | { error: unknown };

/**
 * Claims and runs jobs until the queue is empty or the time budget is spent. Reclaims jobs whose
 * lease expired first. A `PermanentJobError` fails the job at once; any other throw is retried with
 * backoff until `maxAttempts`. A step that loses its lock token is dropped, not overwritten.
 */
export async function runJobs(options: RunnerOptions): Promise<RunSummary> {
  const { queue, registry } = options;
  const now = options.now ?? (() => new Date());
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const start = now().getTime();
  const deadline = start + budgetMs;

  const summary: RunSummary = {
    ran: 0,
    succeeded: 0,
    continued: 0,
    deferred: 0,
    retried: 0,
    failed: 0,
    lostLease: 0,
    reclaimed: 0,
    budgetExhausted: false,
  };

  // One answer per owner for this invocation (a rejected lookup is remembered too, so an outage
  // costs one query, not one per job).
  const approvals = new Map<string, Promise<boolean>>();
  const mayRun = (ownerId: string): Promise<boolean> => {
    if (!options.canRun) return Promise.resolve(true);
    let answer = approvals.get(ownerId);
    if (!answer) {
      answer = options.canRun(ownerId);
      approvals.set(ownerId, answer);
    }
    return answer;
  };

  summary.reclaimed = await queue.reclaimStale(leaseMs);

  for (;;) {
    if (now().getTime() >= deadline) {
      summary.budgetExhausted = true;
      break;
    }
    const job = await queue.claimNext();
    if (!job) break;
    summary.ran += 1;
    await runOne(job, deadline);
  }
  return summary;

  async function runOne(job: ClaimedJob, jobDeadline: number): Promise<void> {
    const claim: Claim = { id: job.id, lockToken: job.lockToken };
    const run = (await options.runs?.start(job)) ?? null;
    const finishRun = (
      applied: boolean,
      outcome: JobRunOutcome,
      errorCode: string | null,
    ) =>
      options.runs?.finish(
        run,
        applied ? outcome : "failed",
        applied ? errorCode : "lease_lost",
      );
    // Before anything of the owner's runs. Fails closed; no data is touched, and onFailure hears
    // only of the unexpected case (a lookup that never succeeds), not of an expected refusal.
    let approved: boolean;
    try {
      approved = await mayRun(job.ownerId);
    } catch (error) {
      logger.warn(
        { module: "jobs", errorName: error instanceof Error ? error.name : "unknown" },
        "jobs: the owner's approval could not be checked, the job is retried later",
      );
      const retry = job.attempts + 1 < job.maxAttempts;
      const retryAt = retry ? new Date(now().getTime() + backoffMs(job.attempts)) : null;
      const applied = await queue.fail(claim, APPROVAL_CHECK_FAILURE, retryAt);
      record(applied, retry ? "retried" : "failed");
      await finishRun(
        applied,
        retry ? "deferred" : "failed",
        APPROVAL_CHECK_FAILURE.code,
      );
      if (applied && !retry) await reportFailure(job, APPROVAL_CHECK_FAILURE);
      return;
    }
    if (!approved) {
      // Expected outcome (an address left the approval list): not an error-log row, only counted.
      const applied = await queue.fail(claim, NOT_APPROVED_FAILURE, null);
      record(applied, "failed");
      await finishRun(applied, "failed", NOT_APPROVED_FAILURE.code);
      return;
    }

    const handler = registry.get(job.type);

    if (!handler) {
      const failure: JobFailure = {
        code: "unknown_job_type",
        message: `No handler is registered for job type "${job.type}".`,
      };
      const applied = await queue.fail(claim, failure, null);
      record(applied, "failed");
      await finishRun(applied, "failed", failure.code);
      if (applied) await reportFailure(job, failure);
      return;
    }

    // Run the handler on its own so a failure to save its outcome is not mistaken for a handler
    // error. If saving throws (e.g. the database is down) the job stays running until its lease
    // expires and the next run reclaims it.
    let outcome: Outcome;
    try {
      const result: unknown = await handler({
        job,
        ownerId: job.ownerId,
        progress: (job.progress ?? null) as Progress | null,
        correlationId: job.correlationId,
        deadline: jobDeadline,
      });
      if (!isValidHandlerResult(result)) {
        throw new PermanentJobError(
          "invalid_handler_result",
          "Handler returned an invalid result.",
        );
      }
      outcome = { result };
    } catch (error) {
      outcome = { error };
    }

    if ("error" in outcome) {
      const permanent = outcome.error instanceof PermanentJobError;
      const retry = !permanent && job.attempts + 1 < job.maxAttempts;
      const retryAt = retry ? new Date(now().getTime() + backoffMs(job.attempts)) : null;
      const failure = describeFailure(outcome.error);
      const applied = await queue.fail(claim, failure, retryAt);
      record(applied, retry ? "retried" : "failed");
      await finishRun(applied, retry ? "deferred" : "failed", failure.code);
      if (applied && !retry) await reportFailure(job, failure);
      return;
    }

    const { result } = outcome;
    if (result.kind === "done") {
      const applied = await queue.complete(claim, result.progress);
      record(applied, "succeeded");
      await finishRun(applied, "succeeded", null);
    } else if (result.kind === "continue") {
      // The step succeeded; the job goes back to the queue for its next step.
      const applied = await queue.continueJob(claim, result.progress);
      record(applied, "continued");
      await finishRun(applied, "succeeded", null);
    } else {
      const applied = await queue.defer(claim, result.runAfter, result.progress);
      record(applied, "deferred");
      await finishRun(applied, "deferred", null);
    }
  }

  async function reportFailure(job: ClaimedJob, failure: JobFailure): Promise<void> {
    if (!options.onFailure) return;
    try {
      await options.onFailure({ job, failure });
    } catch (error) {
      logger.error({ module: "jobs", err: error }, "jobs: onFailure hook failed");
    }
  }

  function record(
    applied: boolean,
    kind: "succeeded" | "continued" | "deferred" | "retried" | "failed",
  ): void {
    if (applied) summary[kind] += 1;
    else summary.lostLease += 1;
  }
}
