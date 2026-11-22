import "server-only";
import { Worker, type ResourceLimits } from "node:worker_threads";

// Ruling R10: untrusted files are parsed in a worker thread with its own heap limits and a hard
// timeout, never in the request or job process. A worker killed by its heap limit, a timeout or
// any crash is an ordinary result here; the caller maps it to a rejection.
//
// Ruling R29: one parse at a time per process. Fluid compute serves concurrent requests (and the
// job runner) from one instance, and each parser worker may use hundreds of MB, so every run
// takes a process-wide slot first:
// - FIFO with turns between owners: an owner may have one waiting parse besides a running one
//   (R31: several files dropped at once), never two waiting; the next grant goes to another
//   owner's waiter first, so one teacher cannot starve another; at most MAX_SLOT_WAITERS waiting
//   in all (more is `busy` at once);
// - a caller waits at most `waitMs` (default DEFAULT_SLOT_WAIT_MS for the request path, never more
//   than MAX_SLOT_WAIT_MS); then `busy` (it retries or defers; nothing was parsed);
// - the bytes for the worker are prepared (copied) only once the slot is held (`payload`);
// - the slot is released after the worker was terminated, on every path, and never waits more
//   than TERMINATE_GRACE_MS for a terminate that hangs; a watchdog (timeout + grace) releases it
//   once if anything else hangs, so a worker that refuses to die cannot stop parsing in the process.

export type BoundedWorkerResult<T> =
  { ok: true; value: T } | { ok: false; reason: "timeout" | "crash" | "busy" };

/** How long a request waits for the slot unless the caller says otherwise. */
export const DEFAULT_SLOT_WAIT_MS = 10_000;
/** The longest wait any caller may ask for (ingestion defers by its job deadline instead). */
export const MAX_SLOT_WAIT_MS = 60_000;
/** Parses waiting for the slot at most; more are refused at once. */
export const MAX_SLOT_WAITERS = 4;
/** How long a terminate() may take before the slot is released anyway. */
export const TERMINATE_GRACE_MS = 2_000;

/** The parts of a worker thread this module uses (a test passes its own). */
export interface WorkerLike {
  stdout: { resume(): unknown };
  stderr: { resume(): unknown };
  once(event: "message", listener: (value: unknown) => void): unknown;
  once(event: "error" | "exit", listener: () => void): unknown;
  terminate(): Promise<number>;
}

interface Waiter {
  ownerId: string;
  grant: () => void;
}

let holder: string | null = null;
const waiting: Waiter[] = [];

/** Takes the slot for `ownerId`, or answers false (busy) at once or after `waitMs`. */
function acquireSlot(ownerId: string, waitMs: number): Promise<boolean> {
  // One waiting place per owner (R31: a teacher may wait behind their own running parse, e.g.
  // several files dropped at once, but not hold two places in the queue).
  if (waiting.some((waiter) => waiter.ownerId === ownerId)) {
    return Promise.resolve(false);
  }
  if (holder === null) {
    holder = ownerId;
    return Promise.resolve(true);
  }
  // A run that may not wait (the dependency probe) never takes a place in the queue.
  if (waitMs <= 0) return Promise.resolve(false);
  if (waiting.length >= MAX_SLOT_WAITERS) return Promise.resolve(false);
  return new Promise((resolve) => {
    const waiter: Waiter = {
      ownerId,
      grant: () => {
        clearTimeout(timer);
        resolve(true);
      },
    };
    const timer = setTimeout(
      () => {
        const index = waiting.indexOf(waiter);
        if (index >= 0) waiting.splice(index, 1);
        resolve(false);
      },
      Math.min(Math.max(0, waitMs), MAX_SLOT_WAIT_MS),
    );
    waiting.push(waiter);
  });
}

/**
 * Hands the slot to the first waiter of ANOTHER owner than the one leaving (owners take turns,
 * so one teacher's queued files never starve another), else to the leaving owner's own waiter,
 * else frees it.
 */
function releaseSlot(): void {
  if (waiting.length === 0) {
    holder = null;
    return;
  }
  const leaving = holder;
  const index = waiting.findIndex((waiter) => waiter.ownerId !== leaving);
  const [next] = waiting.splice(index >= 0 ? index : 0, 1);
  holder = next.ownerId;
  next.grant();
}

interface WorkerInput {
  data: unknown;
  transfer?: ArrayBuffer[];
}

export interface BoundedWorkerOptions extends Partial<WorkerInput> {
  /** The teacher the parse is for (one queued or running parse per owner). */
  ownerId: string;
  /** Builds the worker's data once the slot is held (copy the bytes here, not before). */
  payload?: () => WorkerInput;
  timeoutMs: number;
  /** How long to wait for the slot before answering `busy` (clamped to MAX_SLOT_WAIT_MS). */
  waitMs?: number;
  resourceLimits: ResourceLimits;
  /** Test seams. */
  createWorker?: (
    url: URL,
    options: ConstructorParameters<typeof Worker>[1],
  ) => WorkerLike;
  terminateGraceMs?: number;
}

/**
 * Runs the worker module at `url` and resolves with the FIRST message it posts. The worker is
 * terminated afterwards in every case (answer, timeout, error, exit without an answer). Never
 * rejects.
 */
export async function runBoundedWorker<T>(
  url: URL,
  options: BoundedWorkerOptions,
): Promise<BoundedWorkerResult<T>> {
  if (!(await acquireSlot(options.ownerId, options.waitMs ?? DEFAULT_SLOT_WAIT_MS))) {
    return { ok: false, reason: "busy" };
  }
  const grace = options.terminateGraceMs ?? TERMINATE_GRACE_MS;
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    clearTimeout(watchdog);
    releaseSlot();
  };
  // The last resort: whatever hangs, the slot comes back after the run's time and the grace.
  const watchdog = setTimeout(releaseOnce, options.timeoutMs + 2 * grace + 1_000);
  try {
    let input: WorkerInput;
    try {
      input = options.payload
        ? options.payload()
        : { data: options.data, transfer: options.transfer };
    } catch {
      return { ok: false, reason: "crash" };
    }
    return await runOne<T>(url, input, options, grace);
  } finally {
    releaseOnce();
  }
}

/** One worker run; resolves once the worker has been terminated (or the grace ran out). */
function runOne<T>(
  url: URL,
  input: WorkerInput,
  options: BoundedWorkerOptions,
  grace: number,
): Promise<BoundedWorkerResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    let worker: WorkerLike;
    const finish = (result: BoundedWorkerResult<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The memory is given back before the next parse may start, but a terminate that never
      // returns cannot hold the slot for more than the grace.
      let done = false;
      const resolveOnce = () => {
        if (done) return;
        done = true;
        clearTimeout(graceTimer);
        resolve(result);
      };
      const graceTimer = setTimeout(resolveOnce, grace);
      worker.terminate().then(resolveOnce, resolveOnce);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, reason: "timeout" });
    }, options.timeoutMs);
    try {
      const workerOptions = {
        workerData: input.data,
        transferList: input.transfer,
        resourceLimits: options.resourceLimits,
        // The worker's own console output is not the app's log.
        stdout: true,
        stderr: true,
      };
      worker = options.createWorker
        ? options.createWorker(url, workerOptions)
        : new Worker(url, workerOptions);
    } catch {
      clearTimeout(timer);
      settled = true;
      resolve({ ok: false, reason: "crash" });
      return;
    }
    worker.stdout.resume();
    worker.stderr.resume();
    worker.once("message", (value: unknown) => {
      finish({ ok: true, value: value as T });
    });
    // ERR_WORKER_OUT_OF_MEMORY and any uncaught error in the worker.
    worker.once("error", () => {
      finish({ ok: false, reason: "crash" });
    });
    worker.once("exit", () => {
      finish({ ok: false, reason: "crash" });
    });
  });
}
