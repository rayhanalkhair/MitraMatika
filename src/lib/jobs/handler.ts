import type { ClaimedJob, Progress } from "./types";

export interface JobContext {
  job: ClaimedJob;
  ownerId: string;
  // The progress saved by the previous step, or null on the first run.
  progress: Progress | null;
  correlationId: string;
  // Epoch milliseconds by which the handler should return (the runner's step budget). It is
  // cooperative: a handler that runs past the function's time limit is killed by the platform and
  // counted as a crash (one failure) after the 10-minute lease, so keep steps well inside it.
  deadline: number;
}

export type HandlerResult =
  | { kind: "done"; progress?: Progress }
  | { kind: "continue"; progress: Progress }
  | { kind: "defer"; runAfter: Date; progress?: Progress };

/**
 * Handlers must be idempotent per (job id, step): the runner may run a step again after a crash
 * or a lost lease, starting from the last saved progress (ADR-0007).
 */
export type JobHandler = (ctx: JobContext) => Promise<HandlerResult>;

/**
 * Throw this for failures that retrying cannot fix; the job fails at once.
 */
export class PermanentJobError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PermanentJobError";
    this.code = code;
  }
}

/**
 * Throw this for a failure the runner should retry with backoff, but whose code the teacher-facing
 * status needs (for example `provider_unavailable`). The message must be a fixed sentence: it is
 * stored in the job row.
 */
export class RetryableJobError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RetryableJobError";
    this.code = code;
  }
}
