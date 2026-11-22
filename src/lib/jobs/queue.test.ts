import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { jobRuns, jobs } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { createJobQueue } from "./queue";
import { createJobRunLog } from "./run-log";
import type { Claim } from "./types";

const T0 = Date.parse("2026-10-05T10:00:00.000Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;

let database: TestDatabase;
let nowMs = T0;
const clock = () => new Date(nowMs);
const queue = () => createJobQueue(database.db, clock);
const enqueue = (overrides: Record<string, unknown> = {}) =>
  queue().enqueue({ ownerId: USER_A, type: "demo", ...overrides });
const rowOf = async (id: string) =>
  (await database.db.select().from(jobs).where(eq(jobs.id, id)))[0];
const claimOf = (job: { id: string; lockToken: string }): Claim => ({
  id: job.id,
  lockToken: job.lockToken,
});
const progress = (step: string, done: number, total = 3) => ({ step, done, total });

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await database.client.close();
});

beforeEach(async () => {
  nowMs = T0;
  await database.db.delete(jobs);
});

describe("enqueue", () => {
  it("stores a queued job for the given owner with the column defaults", async () => {
    const job = await enqueue();
    expect(job).toMatchObject({
      ownerId: USER_A,
      type: "demo",
      status: "queued",
      payload: {},
      priority: 0,
      attempts: 0,
      maxAttempts: 3,
      lockToken: null,
    });
    expect(job.runAfter.getTime()).toBe(T0);
  });

  it("stores explicit values", async () => {
    const runAfter = new Date(T0 + MINUTE);
    const job = await enqueue({
      payload: { n: 1 },
      priority: 7,
      runAfter,
      maxAttempts: 5,
    });
    expect(job).toMatchObject({ payload: { n: 1 }, priority: 7, maxAttempts: 5 });
    expect(job.runAfter.getTime()).toBe(runAfter.getTime());
  });

  it("stores a caller's creation time when one is given", async () => {
    const createdAt = new Date("2026-01-02T03:04:05.000Z");
    const job = await enqueue({ createdAt });
    expect(job.createdAt.getTime()).toBe(createdAt.getTime());
  });

  it("stores an explicit deferred status and is claimable only once run_after passes", async () => {
    const job = await enqueue({
      status: "deferred",
      runAfter: new Date(T0 + 5 * MINUTE),
    });
    expect(job).toMatchObject({ status: "deferred" });
    expect(await queue().claimNext()).toBeNull();
    nowMs = T0 + 5 * MINUTE;
    const claimed = await queue().claimNext();
    expect(claimed?.id).toBe(job.id);
    expect((await rowOf(job.id)).status).toBe("running");
  });
});

describe("claimNext", () => {
  it("returns null when nothing is due", async () => {
    expect(await queue().claimNext()).toBeNull();
  });

  it("claims by priority, then run_after, then creation order", async () => {
    const low = await enqueue({ runAfter: new Date(T0 - 2 * SECOND) });
    const high = await enqueue({ priority: 5, runAfter: new Date(T0 - SECOND) });
    const earliest = await enqueue({ runAfter: new Date(T0 - 3 * SECOND) });

    const order = [
      (await queue().claimNext())!.id,
      (await queue().claimNext())!.id,
      (await queue().claimNext())!.id,
    ];
    expect(order).toEqual([high.id, earliest.id, low.id]);
    expect(await queue().claimNext()).toBeNull();
  });

  it("breaks priority and run_after ties by created_at (FIFO)", async () => {
    // Insertion order is the reverse of the created_at order, so neither insertion order nor
    // (random) ids can produce the expected sequence by accident.
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await enqueue()).id);
    const fifo = [...ids].reverse();
    for (const [rank, id] of fifo.entries()) {
      await database.db
        .update(jobs)
        .set({ createdAt: new Date(T0 - (10 - rank) * MINUTE) })
        .where(eq(jobs.id, id));
    }
    const claimed: string[] = [];
    for (let i = 0; i < 6; i++) claimed.push((await queue().claimNext())!.id);
    expect(claimed).toEqual(fifo);
  });

  it("marks the job running with a fresh lock and does not count it as an attempt", async () => {
    const job = await enqueue();
    const claimed = (await queue().claimNext())!;
    expect(claimed.id).toBe(job.id);
    expect(claimed.status).toBe("running");
    expect(claimed.lockToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(claimed.lockedAt?.getTime()).toBe(T0);
    expect(claimed.attempts).toBe(0);
  });

  it("does not claim a job that is not due yet, then claims it once it is", async () => {
    await enqueue({ runAfter: new Date(T0 + MINUTE) });
    expect(await queue().claimNext()).toBeNull();
    nowMs = T0 + MINUTE;
    expect(await queue().claimNext()).not.toBeNull();
  });

  it("treats deferred jobs like queued ones once their run_after passes", async () => {
    await enqueue();
    const claim = claimOf((await queue().claimNext())!);
    await queue().defer(claim, new Date(T0 + 5 * MINUTE), progress("wait", 1));
    expect(await queue().claimNext()).toBeNull();
    nowMs = T0 + 5 * MINUTE;
    const again = (await queue().claimNext())!;
    expect(again.id).toBe(claim.id);
    expect(again.lockToken).not.toBe(claim.lockToken);
  });

  it("never claims succeeded, failed or running jobs", async () => {
    const a = await enqueue({ runAfter: new Date(T0 - 3 * SECOND) });
    const b = await enqueue({ runAfter: new Date(T0 - 2 * SECOND) });
    const c = await enqueue({ runAfter: new Date(T0 - SECOND) });
    const claimA = claimOf((await queue().claimNext())!);
    const claimB = claimOf((await queue().claimNext())!);
    await queue().complete(claimA);
    await queue().fail(claimB, { code: "x", message: "x" }, null);
    expect(claimA.id).toBe(a.id);
    expect(claimB.id).toBe(b.id);
    expect(await rowOf(c.id)).toMatchObject({ status: "queued" });
    expect((await queue().claimNext())?.id).toBe(c.id);
    expect(await queue().claimNext()).toBeNull();
  });
});

describe("transitions", () => {
  it("complete marks succeeded, clears the lock and error, and stores the final progress", async () => {
    await enqueue();
    const claim = claimOf((await queue().claimNext())!);
    expect(await queue().complete(claim, progress("done", 3))).toBe(true);
    expect(await rowOf(claim.id)).toMatchObject({
      status: "succeeded",
      lockToken: null,
      lockedAt: null,
      error: null,
      progress: progress("done", 3),
    });
  });

  it("complete without progress keeps the progress saved by continueJob", async () => {
    await enqueue();
    await queue().continueJob(
      claimOf((await queue().claimNext())!),
      progress("step-1", 1),
    );
    const claim = claimOf((await queue().claimNext())!);
    expect(await queue().complete(claim)).toBe(true);
    expect(await rowOf(claim.id)).toMatchObject({
      status: "succeeded",
      progress: progress("step-1", 1),
    });
  });

  it("fail truncates long messages to exactly 300 characters", async () => {
    await enqueue();
    const claim = claimOf((await queue().claimNext())!);
    await queue().fail(claim, { code: "x", message: "a".repeat(1000) }, null);
    const row = await rowOf(claim.id);
    expect((row.error as { message: string }).message).toHaveLength(300);
  });

  it("fail truncates by code point so an emoji at the boundary stays valid", async () => {
    await enqueue();
    const claim = claimOf((await queue().claimNext())!);
    const message = "a".repeat(299) + "😀" + "b".repeat(50);
    expect(await queue().fail(claim, { code: "x", message }, null)).toBe(true);
    const stored = ((await rowOf(claim.id)).error as { message: string }).message;
    expect(Array.from(stored).length).toBeLessThanOrEqual(300);
    expect(stored.isWellFormed()).toBe(true);
    expect(stored.startsWith("a".repeat(299))).toBe(true);
  });

  it("continueJob re-queues immediately with the saved progress", async () => {
    await enqueue();
    const claim = claimOf((await queue().claimNext())!);
    nowMs = T0 + 10 * SECOND;
    expect(await queue().continueJob(claim, progress("step-1", 1))).toBe(true);
    const row = await rowOf(claim.id);
    expect(row).toMatchObject({ status: "queued", lockToken: null, attempts: 0 });
    expect(row.runAfter.getTime()).toBe(T0 + 10 * SECOND);
    const next = (await queue().claimNext())!;
    expect(next.id).toBe(claim.id);
    expect(next.progress).toEqual(progress("step-1", 1));
  });

  it("defer stores the resume time and progress", async () => {
    await enqueue();
    const claim = claimOf((await queue().claimNext())!);
    const resume = new Date(T0 + 3 * 60 * MINUTE);
    const waiting = { ...progress("quota", 1), messageKey: "quota_wait" };
    expect(await queue().defer(claim, resume, waiting)).toBe(true);
    const row = await rowOf(claim.id);
    expect(row).toMatchObject({ status: "deferred", lockToken: null, progress: waiting });
    expect(row.runAfter.getTime()).toBe(resume.getTime());
  });

  it("fail with a retry time re-queues, counts the attempt and stores the error", async () => {
    await enqueue();
    const claim = claimOf((await queue().claimNext())!);
    const retryAt = new Date(T0 + 30 * SECOND);
    expect(
      await queue().fail(claim, { code: "boom", message: "it broke" }, retryAt),
    ).toBe(true);
    const row = await rowOf(claim.id);
    expect(row).toMatchObject({
      status: "queued",
      attempts: 1,
      lockToken: null,
      error: { code: "boom", message: "it broke" },
    });
    expect(row.runAfter.getTime()).toBe(retryAt.getTime());
  });

  it("fail without a retry time marks the job failed", async () => {
    await enqueue();
    const claim = claimOf((await queue().claimNext())!);
    expect(await queue().fail(claim, { code: "fatal", message: "no" }, null)).toBe(true);
    expect(await rowOf(claim.id)).toMatchObject({ status: "failed", attempts: 1 });
  });

  it.each([
    ["complete", (q: ReturnType<typeof queue>, c: Claim) => q.complete(c)],
    [
      "continueJob",
      (q: ReturnType<typeof queue>, c: Claim) => q.continueJob(c, progress("s", 1)),
    ],
    [
      "defer",
      (q: ReturnType<typeof queue>, c: Claim) => q.defer(c, new Date(T0 + MINUTE)),
    ],
    [
      "fail",
      (q: ReturnType<typeof queue>, c: Claim) =>
        q.fail(c, { code: "x", message: "x" }, null),
    ],
  ])(
    "%s with the wrong lock token changes nothing and returns false",
    async (_name, act) => {
      await enqueue();
      const claimed = (await queue().claimNext())!;
      const before = await rowOf(claimed.id);
      const wrong: Claim = {
        id: claimed.id,
        lockToken: "00000000-0000-4000-8000-000000000000",
      };
      expect(await act(queue(), wrong)).toBe(false);
      expect(await rowOf(claimed.id)).toEqual(before);
    },
  );

  it("a claim cannot be used twice: after complete every transition returns false", async () => {
    await enqueue();
    const claim = claimOf((await queue().claimNext())!);
    expect(await queue().complete(claim)).toBe(true);
    expect(await queue().complete(claim)).toBe(false);
    expect(await queue().fail(claim, { code: "x", message: "x" }, null)).toBe(false);
    expect(await rowOf(claim.id)).toMatchObject({ status: "succeeded", attempts: 0 });
  });
});

describe("status guard", () => {
  it("rejects a matching lock token when the job is no longer running", async () => {
    await enqueue();
    const claim = claimOf((await queue().claimNext())!);
    // Defensive: every transition clears the token, but the guard must not depend on that.
    await database.db.update(jobs).set({ status: "failed" }).where(eq(jobs.id, claim.id));
    expect(await queue().complete(claim)).toBe(false);
    expect(await rowOf(claim.id)).toMatchObject({ status: "failed" });
  });
});

describe("reclaimStale", () => {
  it("never closes an attempt that started after the reclaim (concurrent runner)", async () => {
    const job = await enqueue();
    const claim = claimOf((await queue().claimNext())!);
    const [orphan] = await database.db
      .insert(jobRuns)
      .values({
        jobId: job.id,
        ownerId: USER_A,
        startedAt: new Date(T0),
        outcome: "running",
      })
      .returning();
    nowMs = T0 + 11 * MINUTE;
    let fresh: typeof orphan | undefined;
    // Runs after the job was requeued but before the orphan close: another runner claims the job
    // and opens its attempt.
    const interleave = async () => {
      await queue().claimNext();
      [fresh] = await database.db
        .insert(jobRuns)
        .values({
          jobId: job.id,
          ownerId: USER_A,
          startedAt: clock(),
          outcome: "running",
        })
        .returning();
    };
    const racing = new Proxy(database.db, {
      get(target, prop, receiver) {
        if (prop !== "update") return Reflect.get(target, prop, receiver) as unknown;
        return (table: unknown) => {
          const real = target.update(table as typeof jobs);
          if (table !== jobRuns) return real;
          return {
            set: (values: never) => ({
              where: (condition: never) => ({
                then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
                  interleave()
                    .then(() => real.set(values).where(condition))
                    .then(resolve, reject),
              }),
            }),
          };
        };
      },
    });
    expect(await createJobQueue(racing, clock).reclaimStale(10 * MINUTE)).toBe(1);
    const rows = await database.db
      .select()
      .from(jobRuns)
      .where(eq(jobRuns.jobId, claim.id));
    expect(rows.find((r) => r.id === orphan.id)).toMatchObject({
      outcome: "failed",
      errorCode: "lease_expired",
    });
    expect(rows.find((r) => r.id === fresh!.id)).toMatchObject({
      outcome: "running",
      finishedAt: null,
      errorCode: null,
    });
  });

  it("closes the open run of a job whose lock is only 1 ms past the lease", async () => {
    const job = await enqueue();
    const claimed = (await queue().claimNext())!;
    // The run's clock runs 2 ms ahead of the claim's, like a DB default against the runner clock:
    // started_at must still be the claim's locked_at, not the run clock's reading.
    const runLog = createJobRunLog(database.db, () => new Date(T0 + 2));
    const open = (await runLog.start(claimed))!;
    expect(open.startedAt.getTime()).toBe(T0);
    nowMs = T0 + 10 * MINUTE + 1;
    expect(await queue().reclaimStale(10 * MINUTE)).toBe(1);
    const rows = await database.db
      .select()
      .from(jobRuns)
      .where(eq(jobRuns.jobId, job.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "failed",
      errorCode: "lease_expired",
    });
    expect(rows[0].finishedAt).not.toBeNull();
    expect(rows.filter((r) => r.finishedAt === null)).toEqual([]);
  });

  it("closes the open job_runs row of a reclaimed job and leaves finished ones", async () => {
    const job = await enqueue();
    const claim = claimOf((await queue().claimNext())!);
    const [open] = await database.db
      .insert(jobRuns)
      .values({
        jobId: job.id,
        ownerId: USER_A,
        startedAt: new Date(T0),
        outcome: "running",
      })
      .returning();
    const [done] = await database.db
      .insert(jobRuns)
      .values({
        jobId: job.id,
        ownerId: USER_A,
        startedAt: new Date(T0 - MINUTE),
        finishedAt: new Date(T0 - 30 * SECOND),
        outcome: "deferred",
      })
      .returning();
    nowMs = T0 + 11 * MINUTE;
    await queue().reclaimStale(10 * MINUTE);
    const rows = await database.db
      .select()
      .from(jobRuns)
      .where(eq(jobRuns.jobId, claim.id));
    const byId = (id: string) => rows.find((r) => r.id === id)!;
    expect(byId(open.id)).toMatchObject({
      outcome: "failed",
      errorCode: "lease_expired",
      durationMs: 11 * MINUTE,
    });
    expect(byId(open.id).finishedAt?.getTime()).toBe(T0 + 11 * MINUTE);
    expect(byId(done.id)).toMatchObject({ outcome: "deferred", errorCode: null });
  });

  it("re-queues a running job whose lease expired, counting one failure", async () => {
    await enqueue();
    const claim = claimOf((await queue().claimNext())!);
    nowMs = T0 + 11 * MINUTE;
    expect(await queue().reclaimStale(10 * MINUTE)).toBe(1);
    const row = await rowOf(claim.id);
    expect(row).toMatchObject({
      status: "queued",
      attempts: 1,
      lockToken: null,
      error: { code: "lease_expired" },
    });
    expect(row.runAfter.getTime()).toBe(T0 + 11 * MINUTE);
  });

  it("leaves a running job whose lease has not expired alone", async () => {
    await enqueue();
    const claim = claimOf((await queue().claimNext())!);
    nowMs = T0 + 9 * MINUTE;
    expect(await queue().reclaimStale(10 * MINUTE)).toBe(0);
    expect(await rowOf(claim.id)).toMatchObject({ status: "running" });
  });

  it("fails the job for good when no attempts remain", async () => {
    await enqueue({ maxAttempts: 1 });
    const claim = claimOf((await queue().claimNext())!);
    nowMs = T0 + 11 * MINUTE;
    expect(await queue().reclaimStale(10 * MINUTE)).toBe(1);
    expect(await rowOf(claim.id)).toMatchObject({
      status: "failed",
      attempts: 1,
      error: { code: "lease_expired" },
    });
  });

  it("only touches running jobs, even ones carrying an old locked_at", async () => {
    const done = await enqueue({ runAfter: new Date(T0 - SECOND) });
    const queued = await enqueue();
    const doneClaim = claimOf((await queue().claimNext())!);
    await queue().complete(doneClaim);
    const old = new Date(T0 - 60 * MINUTE);
    await database.db.update(jobs).set({ lockedAt: old }).where(eq(jobs.id, queued.id));
    await database.db
      .update(jobs)
      .set({ lockedAt: old })
      .where(eq(jobs.id, doneClaim.id));
    nowMs = T0 + 60 * MINUTE;
    expect(await queue().reclaimStale(10 * MINUTE)).toBe(0);
    expect((await rowOf(queued.id)).status).toBe("queued");
    expect((await rowOf(doneClaim.id)).status).toBe("succeeded");
    expect(done.id).toBe(doneClaim.id);
  });

  it("reclaims only when the lock is strictly older than the lease", async () => {
    await enqueue();
    await queue().claimNext();
    nowMs = T0 + 10 * MINUTE; // locked_at is exactly now - leaseMs
    expect(await queue().reclaimStale(10 * MINUTE)).toBe(0);
    nowMs = T0 + 10 * MINUTE + 1;
    expect(await queue().reclaimStale(10 * MINUTE)).toBe(1);
  });

  it("makes the old claim unusable: it can no longer complete the reclaimed job", async () => {
    await enqueue();
    const oldClaim = claimOf((await queue().claimNext())!);
    nowMs = T0 + 11 * MINUTE;
    await queue().reclaimStale(10 * MINUTE);
    const newClaim = claimOf((await queue().claimNext())!);
    expect(await queue().complete(oldClaim)).toBe(false);
    expect(await queue().complete(newClaim)).toBe(true);
  });
});

describe("crash and resume", () => {
  it("resumes from the last saved progress after a runner dies mid-step", async () => {
    await enqueue();
    // Step 1 completes and saves progress.
    const first = claimOf((await queue().claimNext())!);
    await queue().continueJob(first, progress("step-1", 1));

    // Step 2 starts, then the runner "crashes": it never completes or fails.
    const second = (await queue().claimNext())!;
    expect(second.progress).toEqual(progress("step-1", 1));
    expect(await queue().claimNext()).toBeNull();

    // Time passes beyond the lease; the next runner reclaims and resumes.
    nowMs = T0 + 11 * MINUTE;
    expect(await queue().reclaimStale(10 * MINUTE)).toBe(1);
    const resumed = (await queue().claimNext())!;
    expect(resumed.id).toBe(second.id);
    expect(resumed.lockToken).not.toBe(second.lockToken);
    expect(resumed.progress).toEqual(progress("step-1", 1));
    expect(resumed.attempts).toBe(1);
    expect(await queue().complete(claimOf(resumed), progress("done", 3))).toBe(true);
  });
});
