import type { jobs } from "@/lib/db/schema";

export type JobRow = typeof jobs.$inferSelect;

// A job returned by claimNext: the row plus the lock token that every later transition must present.
export type ClaimedJob = JobRow & { lockToken: string };
export interface Claim {
  id: string;
  lockToken: string;
}

export interface Progress {
  step: string;
  done: number;
  total: number;
  messageKey?: string;
  [key: string]: unknown;
}

export interface JobFailure {
  code: string;
  message: string;
}

export interface EnqueueInput {
  ownerId: string;
  type: string;
  payload?: unknown;
  priority?: number;
  runAfter?: Date;
  maxAttempts?: number;
  status?: "queued" | "deferred";
  // Defaults to the database clock. A caller that counts jobs by day passes its own clock.
  createdAt?: Date;
}

// How a finished attempt ended. The stored column also holds `running` while an attempt is in flight.
export type JobRunOutcome = "succeeded" | "failed" | "deferred";

// An open (`running`) `job_runs` row: the attempt's id and when it began (the claim's lock time).
export interface OpenJobRun {
  id: string;
  startedAt: Date;
}

// History of attempts. Best effort: neither call ever throws, and `start` returns null when the
// row could not be written (then `finish` does nothing).
export interface JobRunLog {
  start(job: ClaimedJob): Promise<OpenJobRun | null>;
  // errorCode is a short stable code, never a message or user input.
  finish(
    run: OpenJobRun | null,
    outcome: JobRunOutcome,
    errorCode: string | null,
  ): Promise<void>;
}

export interface JobQueue {
  enqueue(input: EnqueueInput): Promise<JobRow>;
  claimNext(): Promise<ClaimedJob | null>;
  complete(claim: Claim, progress?: Progress): Promise<boolean>;
  // Saves progress and re-queues the job to run again now (the next step of a multi-step job).
  continueJob(claim: Claim, progress: Progress): Promise<boolean>;
  defer(claim: Claim, runAfter: Date, progress?: Progress): Promise<boolean>;
  // Counts one failure. With retryAt the job goes back to queued at that time; with null it is failed.
  fail(claim: Claim, error: JobFailure, retryAt: Date | null): Promise<boolean>;
  // Treats every running job whose lock is older than leaseMs as one crash. Returns how many.
  reclaimStale(leaseMs: number): Promise<number>;
}
