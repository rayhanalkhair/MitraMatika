import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { jobRuns, jobs } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { PermanentJobError, RetryableJobError, type JobHandler } from "./handler";
import { createJobQueue } from "./queue";
import { createRegistry } from "./registry";
import { createJobRunLog } from "./run-log";
import {
  backoffMs,
  DEFAULT_BUDGET_MS,
  isValidHandlerResult,
  runJobs,
  type FailureInfo,
} from "./runner";
import { logger } from "@/lib/logger";

const T0 = Date.parse("2026-10-05T10:00:00.000Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

let database: TestDatabase;
let nowMs = T0;
const now = () => new Date(nowMs);
const queue = () => createJobQueue(database.db, now);
const enqueue = (overrides: Record<string, unknown> = {}) =>
  queue().enqueue({ ownerId: USER_A, type: "demo", ...overrides });
const rowOf = async (id: string) =>
  (await database.db.select().from(jobs).where(eq(jobs.id, id)))[0];

const run = (
  handler: JobHandler | undefined,
  options: {
    budgetMs?: number;
    leaseMs?: number;
    onFailure?: (info: FailureInfo) => Promise<void>;
    runs?: ReturnType<typeof createJobRunLog>;
  } = {},
) => {
  const registry = createRegistry();
  if (handler) registry.register("demo", handler);
  return runJobs({
    queue: queue(),
    registry,
    now,
    runs: createJobRunLog(database.db, now),
    ...options,
  });
};

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await database.client.close();
});

beforeEach(async () => {
  nowMs = T0;
  await database.db.delete(jobs);
  vi.restoreAllMocks();
});

describe("backoffMs", () => {
  it("doubles from 30 s and caps at 15 minutes", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10].map(backoffMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000,
    ]);
  });
});

describe("isValidHandlerResult", () => {
  const progress = { step: "x", done: 1, total: 2 };

  it("accepts each valid shape", () => {
    expect(isValidHandlerResult({ kind: "done" })).toBe(true);
    expect(isValidHandlerResult({ kind: "done", progress })).toBe(true);
    expect(isValidHandlerResult({ kind: "continue", progress })).toBe(true);
    expect(isValidHandlerResult({ kind: "defer", runAfter: new Date(T0) })).toBe(true);
    expect(
      isValidHandlerResult({ kind: "defer", runAfter: new Date(T0), progress }),
    ).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isValidHandlerResult(undefined)).toBe(false);
    expect(isValidHandlerResult(null)).toBe(false);
    expect(isValidHandlerResult("done")).toBe(false);
    expect(isValidHandlerResult({ kind: "nonsense" })).toBe(false);
    expect(isValidHandlerResult({ kind: "continue", progress: null })).toBe(false);
    expect(isValidHandlerResult({ kind: "defer", runAfter: T0 })).toBe(false);
    expect(isValidHandlerResult({ kind: "defer", runAfter: new Date("x") })).toBe(false);
  });
});

describe("runJobs", () => {
  it("runs a due job to success and reports it", async () => {
    const job = await enqueue();
    const summary = await run(() =>
      Promise.resolve({
        kind: "done",
        progress: { step: "x", done: 1, total: 1 },
      }),
    );
    expect(summary).toMatchObject({
      ran: 1,
      succeeded: 1,
      failed: 0,
      budgetExhausted: false,
    });
    expect(await rowOf(job.id)).toMatchObject({
      status: "succeeded",
      progress: { step: "x", done: 1, total: 1 },
    });
  });

  it("gives the handler the owner, correlation id, saved progress and the deadline", async () => {
    const job = await enqueue();
    let seen: unknown;
    await run(
      (ctx) => {
        seen = ctx;
        return Promise.resolve({ kind: "done" });
      },
      { budgetMs: 5000 },
    );
    expect(seen).toMatchObject({
      ownerId: USER_A,
      correlationId: job.correlationId,
      progress: null,
      deadline: T0 + 5000,
    });
  });

  it("continues a multi-step job in the same run, passing the saved progress to the next step", async () => {
    const job = await enqueue();
    const seenProgress: unknown[] = [];
    const summary = await run((ctx) => {
      seenProgress.push(ctx.progress);
      return Promise.resolve(
        ctx.progress
          ? { kind: "done" }
          : { kind: "continue", progress: { step: "one", done: 1, total: 2 } },
      );
    });
    expect(seenProgress).toEqual([null, { step: "one", done: 1, total: 2 }]);
    expect(summary).toMatchObject({ ran: 2, continued: 1, succeeded: 1 });
    expect(await rowOf(job.id)).toMatchObject({ status: "succeeded", attempts: 0 });
  });

  it("defers a job and does not pick it up again in the same run", async () => {
    const job = await enqueue();
    const resume = new Date(T0 + 2 * 60 * MINUTE);
    const summary = await run(() =>
      Promise.resolve({
        kind: "defer",
        runAfter: resume,
        progress: { step: "quota", done: 0, total: 1, messageKey: "quota_wait" },
      }),
    );
    expect(summary).toMatchObject({ ran: 1, deferred: 1 });
    const row = await rowOf(job.id);
    expect(row.status).toBe("deferred");
    expect(row.runAfter.getTime()).toBe(resume.getTime());
  });

  it("retries a throwing handler with backoff until max_attempts, then fails it", async () => {
    const job = await enqueue();
    const boom: JobHandler = () => {
      return Promise.reject(new Error("boom"));
    };

    await run(boom);
    let row = await rowOf(job.id);
    expect(row).toMatchObject({
      status: "queued",
      attempts: 1,
      error: { code: "handler_error", message: "boom" },
    });
    expect(row.runAfter.getTime()).toBe(T0 + 30 * SECOND);

    expect((await run(boom)).ran).toBe(0); // not due yet

    nowMs = T0 + 30 * SECOND;
    await run(boom);
    row = await rowOf(job.id);
    expect(row).toMatchObject({ status: "queued", attempts: 2 });
    expect(row.runAfter.getTime()).toBe(nowMs + 60 * SECOND);

    nowMs += 60 * SECOND;
    const summary = await run(boom);
    expect(summary.failed).toBe(1);
    expect(await rowOf(job.id)).toMatchObject({ status: "failed", attempts: 3 });
  });

  it("fails a job at once when the handler throws a PermanentJobError", async () => {
    const job = await enqueue();
    await run(() => {
      return Promise.reject(
        new PermanentJobError("bad_input", "The request is invalid."),
      );
    });
    expect(await rowOf(job.id)).toMatchObject({
      status: "failed",
      attempts: 1,
      error: { code: "bad_input", message: "The request is invalid." },
    });
  });

  it("stores the code of a RetryableJobError and still retries it", async () => {
    const job = await enqueue();
    await run(() => {
      return Promise.reject(
        new RetryableJobError(
          "provider_unavailable",
          "Layanan AI sedang tidak dapat dijangkau.",
        ),
      );
    });
    const row = await rowOf(job.id);
    expect(row).toMatchObject({
      status: "queued",
      attempts: 1,
      error: {
        code: "provider_unavailable",
        message: "Layanan AI sedang tidak dapat dijangkau.",
      },
    });
    expect(row.runAfter.getTime()).toBe(T0 + 30 * SECOND);
  });

  it("fails a RetryableJobError for good on the last attempt with its code", async () => {
    const job = await enqueue({ maxAttempts: 1 });
    const summary = await run(() => {
      return Promise.reject(
        new RetryableJobError("provider_busy", "Layanan AI masih membatasi permintaan."),
      );
    });
    expect(summary.failed).toBe(1);
    expect(await rowOf(job.id)).toMatchObject({
      status: "failed",
      attempts: 1,
      error: { code: "provider_busy" },
    });
  });

  it("truncates long error messages and never stores a stack", async () => {
    const job = await enqueue({ maxAttempts: 1 });
    await run(() => {
      return Promise.reject(new Error("x".repeat(1000)));
    });
    const row = await rowOf(job.id);
    expect((row.error as { message: string }).message).toHaveLength(300);
    expect(Object.keys(row.error as object).sort()).toEqual(["code", "message"]);
  });

  it("fails a job with an unknown type permanently", async () => {
    const job = await enqueue({ type: "mystery" });
    const summary = await run(() => Promise.resolve({ kind: "done" }));
    expect(summary.failed).toBe(1);
    expect(await rowOf(job.id)).toMatchObject({
      status: "failed",
      error: { code: "unknown_job_type" },
    });
  });

  it("stops claiming once the budget is spent and leaves later jobs queued", async () => {
    const first = await enqueue({ priority: 2 });
    const second = await enqueue({ priority: 1 });
    const summary = await run(
      () => {
        nowMs += 10 * SECOND; // the first job uses up the whole budget
        return Promise.resolve({ kind: "done" });
      },
      { budgetMs: 5 * SECOND },
    );
    expect(summary).toMatchObject({ ran: 1, succeeded: 1, budgetExhausted: true });
    expect((await rowOf(first.id)).status).toBe("succeeded");
    expect((await rowOf(second.id)).status).toBe("queued");
  });

  it("runs nothing when the budget is zero", async () => {
    await enqueue();
    const summary = await run(() => Promise.resolve({ kind: "done" }), { budgetMs: 0 });
    expect(summary).toMatchObject({ ran: 0, budgetExhausted: true });
  });

  it("reclaims stale jobs first and then runs them", async () => {
    const job = await enqueue();
    await queue().claimNext(); // a runner that then died
    nowMs = T0 + 11 * MINUTE;
    const summary = await run(() => Promise.resolve({ kind: "done" }));
    expect(summary).toMatchObject({ reclaimed: 1, ran: 1, succeeded: 1 });
    expect(await rowOf(job.id)).toMatchObject({ status: "succeeded", attempts: 1 });
  });

  it("does not run the same job twice when two runners overlap", async () => {
    const ids = [(await enqueue()).id, (await enqueue()).id, (await enqueue()).id];
    const handled: string[] = [];
    const handler: JobHandler = (ctx) => {
      handled.push(ctx.job.id);
      return Promise.resolve({ kind: "done" });
    };
    await Promise.all([run(handler), run(handler)]);
    expect(handled.sort()).toEqual([...ids].sort());
  });

  it("records a lost lease instead of overwriting the newer run", async () => {
    const job = await enqueue();
    let calls = 0;
    const summary = await run(async () => {
      calls += 1;
      if (calls === 1) {
        // While this handler runs, a second runner reclaims the job (the lease is "expired").
        nowMs += 1;
        await queue().reclaimStale(0);
      }
      return { kind: "done" };
    });
    expect(summary.lostLease).toBe(1);
    expect(calls).toBe(2); // the reclaimed job was claimed and finished by the same loop
    expect(await rowOf(job.id)).toMatchObject({ status: "succeeded", attempts: 1 });
  });

  describe("invalid handler results", () => {
    const invalid: [string, unknown][] = [
      ["undefined", undefined],
      ["an unknown kind", { kind: "nonsense" }],
      ["defer without runAfter", { kind: "defer" }],
      ["defer with an invalid date", { kind: "defer", runAfter: new Date("invalid") }],
      ["continue without progress", { kind: "continue" }],
    ];

    it.each(invalid)(
      "fails the job at once when the handler returns %s",
      async (_name, bad) => {
        const first = await enqueue({ priority: 2 });
        const second = await enqueue({ priority: 1 });
        let calls = 0;
        const summary = await run((() => {
          calls += 1;
          return Promise.resolve(calls === 1 ? bad : { kind: "done" });
        }) as unknown as JobHandler);
        expect(await rowOf(first.id)).toMatchObject({
          status: "failed",
          attempts: 1,
          error: {
            code: "invalid_handler_result",
            message: "Handler returned an invalid result.",
          },
        });
        expect((await rowOf(second.id)).status).toBe("succeeded");
        expect(summary).toMatchObject({ ran: 2, failed: 1, succeeded: 1 });
      },
    );
  });

  it("uses a 240 s budget by default", () => {
    expect(DEFAULT_BUDGET_MS).toBe(240_000);
  });
});

describe("onFailure hook", () => {
  const boom: JobHandler = () => {
    return Promise.reject(new Error("boom"));
  };

  it("is called once with the job and failure when a job fails for good", async () => {
    const job = await enqueue({ maxAttempts: 1 });
    const onFailure = vi.fn<(info: FailureInfo) => Promise<void>>(() =>
      Promise.resolve(),
    );
    await run(boom, { onFailure });
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith({
      job: expect.objectContaining({
        id: job.id,
        ownerId: USER_A,
        type: "demo",
      }) as unknown,
      failure: { code: "handler_error", message: "boom" },
    });
  });

  it("is called for a permanent error, an invalid result and an unknown type", async () => {
    await enqueue();
    await enqueue({ type: "mystery" });
    const calls: string[] = [];
    await run(
      (ctx) => {
        if (ctx.job.priority === 0) {
          return Promise.reject(new PermanentJobError("bad_input", "nope"));
        }
        return Promise.resolve({ kind: "done" });
      },
      {
        onFailure: ({ failure }) => {
          calls.push(failure.code);
          return Promise.resolve();
        },
      },
    );
    expect(calls.sort()).toEqual(["bad_input", "unknown_job_type"]);

    await database.db.delete(jobs);
    await enqueue();
    const invalid: string[] = [];
    await run(() => Promise.resolve(undefined as never), {
      onFailure: ({ failure }) => {
        invalid.push(failure.code);
        return Promise.resolve();
      },
    });
    expect(invalid).toEqual(["invalid_handler_result"]);
  });

  it("is not called for a retried failure or a success", async () => {
    await enqueue(); // maxAttempts 3: the first failure is retried
    const onFailure = vi.fn<(info: FailureInfo) => Promise<void>>(() =>
      Promise.resolve(),
    );
    await run(boom, { onFailure });
    await enqueue({ type: "demo" });
    await run(() => Promise.resolve({ kind: "done" }), { onFailure });
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("is called once when retries are exhausted", async () => {
    await enqueue({ maxAttempts: 2 });
    const onFailure = vi.fn<(info: FailureInfo) => Promise<void>>(() =>
      Promise.resolve(),
    );
    await run(boom, { onFailure }); // attempt 1: retried
    nowMs += 31 * SECOND;
    await run(boom, { onFailure }); // attempt 2: final
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("is not called when the transition was not applied (lost lease)", async () => {
    await enqueue({ maxAttempts: 1 });
    const onFailure = vi.fn<(info: FailureInfo) => Promise<void>>(() =>
      Promise.resolve(),
    );
    let calls = 0;
    await run(
      async () => {
        calls += 1;
        if (calls === 1) {
          nowMs += 1;
          await queue().reclaimStale(0); // another runner reclaims it: this claim is stale
          throw new Error("late failure");
        }
        return { kind: "done" };
      },
      { onFailure },
    );
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("swallows a throwing hook so the run continues", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    await enqueue({ maxAttempts: 1, priority: 2 });
    const second = await enqueue({ priority: 1 });
    const summary = await run(
      (ctx) => {
        if (ctx.job.priority === 2) return Promise.reject(new Error("boom"));
        return Promise.resolve({ kind: "done" });
      },
      {
        onFailure: () => {
          return Promise.reject(new Error("hook broke"));
        },
      },
    );
    expect(summary).toMatchObject({ failed: 1, succeeded: 1 });
    expect((await rowOf(second.id)).status).toBe("succeeded");
  });
});

const runsOf = (jobId: string) =>
  database.db
    .select()
    .from(jobRuns)
    .where(eq(jobRuns.jobId, jobId))
    .orderBy(asc(jobRuns.startedAt));

describe("picking up due work", () => {
  it("runs a deferred job whose run_after has passed on the next call", async () => {
    const job = await enqueue();
    await run(() =>
      Promise.resolve({ kind: "defer", runAfter: new Date(T0 + 5 * MINUTE) }),
    );
    expect((await rowOf(job.id)).status).toBe("deferred");
    const handler = vi.fn<JobHandler>(() => Promise.resolve({ kind: "done" }));
    expect(await run(handler)).toMatchObject({ ran: 0 });
    nowMs = T0 + 5 * MINUTE + 1;
    expect(await run(handler)).toMatchObject({ ran: 1, succeeded: 1 });
    expect((await rowOf(job.id)).status).toBe("succeeded");
  });

  it("reclaims a running job past the 10 minute lease, closes its orphaned run and runs it", async () => {
    const job = await enqueue();
    const crashed = createJobRunLog(database.db, now);
    const claimed = (await queue().claimNext())!;
    await crashed.start(claimed);
    expect((await runsOf(job.id))[0]).toMatchObject({
      outcome: "running",
      finishedAt: null,
    });
    nowMs = T0 + 11 * MINUTE;
    const summary = await run(() => Promise.resolve({ kind: "done" }));
    expect(summary).toMatchObject({ reclaimed: 1, ran: 1, succeeded: 1 });
    expect(await rowOf(job.id)).toMatchObject({ status: "succeeded", attempts: 1 });
    const [orphan, retry] = await runsOf(job.id);
    expect(orphan).toMatchObject({
      outcome: "failed",
      errorCode: "lease_expired",
      durationMs: 11 * MINUTE,
    });
    expect(orphan.finishedAt?.getTime()).toBe(T0 + 11 * MINUTE);
    expect(retry).toMatchObject({ outcome: "succeeded", errorCode: null });
  });

  it("does no work and writes no job_runs row when nothing is due", async () => {
    const handler = vi.fn<JobHandler>(() => Promise.resolve({ kind: "done" }));
    const future = await enqueue({ runAfter: new Date(T0 + HOUR) });
    // Count the writes the runner issues: one reclaim UPDATE and one claim UPDATE, both on `jobs`,
    // and nothing else (no insert, nothing on `job_runs`).
    const writes: string[] = [];
    const spied = new Proxy(database.db, {
      get(target, prop, receiver) {
        if (prop !== "update" && prop !== "insert" && prop !== "delete") {
          return Reflect.get(target, prop, receiver) as unknown;
        }
        return (table: unknown) => {
          writes.push(`${prop}:${table === jobs ? "jobs" : "other"}`);
          return (target[prop] as (t: never) => unknown)(table as never);
        };
      },
    });
    const registry = createRegistry();
    registry.register("demo", handler);
    const summary = await runJobs({
      queue: createJobQueue(spied, now),
      registry,
      now,
      runs: createJobRunLog(spied, now),
    });
    expect(summary).toEqual({
      ran: 0,
      succeeded: 0,
      continued: 0,
      deferred: 0,
      retried: 0,
      failed: 0,
      lostLease: 0,
      reclaimed: 0,
      budgetExhausted: false,
    });
    expect(writes).toEqual(["update:jobs", "update:jobs"]);
    expect(handler).not.toHaveBeenCalled();
    expect(await database.db.select().from(jobRuns)).toEqual([]);
    expect((await rowOf(future.id)).status).toBe("queued");
  });
});

describe("job_runs", () => {
  it("records a successful attempt", async () => {
    const job = await enqueue();
    await run(() => {
      nowMs += 1500;
      return Promise.resolve({ kind: "done" });
    });
    const rows = await runsOf(job.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ownerId: USER_A,
      outcome: "succeeded",
      errorCode: null,
      durationMs: 1500,
    });
    expect(rows[0].startedAt.getTime()).toBe(T0);
    expect(rows[0].finishedAt!.getTime()).toBeGreaterThanOrEqual(
      rows[0].startedAt.getTime(),
    );
  });

  it("records a permanent failure with its code and never its message", async () => {
    const job = await enqueue();
    await run(() =>
      Promise.reject(new PermanentJobError("bad_input", "secret teacher text")),
    );
    const rows = await runsOf(job.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ownerId: USER_A,
      outcome: "failed",
      errorCode: "bad_input",
    });
    expect(rows[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(rows[0].finishedAt!.getTime()).toBeGreaterThanOrEqual(
      rows[0].startedAt.getTime(),
    );
    expect(JSON.stringify(rows[0])).not.toContain("secret teacher text");
  });

  it("records a retry as deferred and the last attempt as failed", async () => {
    const job = await enqueue({ maxAttempts: 2 });
    const fail = () => Promise.reject(new Error("boom with user text"));
    await run(fail);
    nowMs = T0 + HOUR;
    await run(fail);
    const rows = await runsOf(job.id);
    expect(rows.map((r) => [r.outcome, r.errorCode])).toEqual([
      ["deferred", "handler_error"],
      ["failed", "handler_error"],
    ]);
  });

  it("records a deferral", async () => {
    const job = await enqueue();
    await run(() => Promise.resolve({ kind: "defer", runAfter: new Date(T0 + HOUR) }));
    const rows = await runsOf(job.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "deferred",
      errorCode: null,
      ownerId: USER_A,
    });
    expect(rows[0].finishedAt!.getTime()).toBeGreaterThanOrEqual(
      rows[0].startedAt.getTime(),
    );
  });

  it("records an unknown job type as failed", async () => {
    const job = await enqueue();
    await run(undefined);
    expect((await runsOf(job.id))[0]).toMatchObject({
      outcome: "failed",
      errorCode: "unknown_job_type",
    });
  });

  it("does not fail the job when job_runs cannot be written", async () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const broken = {
      insert: () => {
        throw new TypeError("relation job_runs does not exist");
      },
      update: () => {
        throw new TypeError("relation job_runs does not exist");
      },
    } as unknown as typeof database.db;
    const job = await enqueue();
    const summary = await run(() => Promise.resolve({ kind: "done" }), {
      runs: createJobRunLog(broken, now),
    });
    expect(summary).toMatchObject({ ran: 1, succeeded: 1 });
    expect((await rowOf(job.id)).status).toBe("succeeded");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("does not exist");
  });
});
