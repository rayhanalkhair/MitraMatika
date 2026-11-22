import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { aiCalls, generationRequests, jobs } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { createGenerationRequest, type CreateRequestInput } from "./request";
import { USER_DAILY_QUESTION_LIMIT, questionsRequestedToday } from "./quota";

let database: TestDatabase;
const NOW = new Date("2026-10-11T10:00:00.000Z");
const VERSION = "33333333-3333-4333-8333-333333333333";

const input = (over: Partial<CreateRequestInput> = {}): CreateRequestInput => ({
  ownerId: USER_A,
  topic: {
    id: "44444444-4444-4444-8444-444444444444",
    stableKey: "spldv",
    title: "SPLDV",
  },
  curriculumVersionId: VERSION,
  quantity: 5,
  difficulty: "sedang",
  now: NOW,
  ...over,
});

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await database.client.close();
});

beforeEach(async () => {
  await database.db.delete(generationRequests);
  await database.db.delete(aiCalls);
  await database.db.delete(jobs);
});

describe("createGenerationRequest", () => {
  it("creates the request and a linked generate_batch job", async () => {
    const result = await createGenerationRequest(database.db, input());
    expect(result).toMatchObject({ ok: true, data: { deferredUntil: null } });
    if (!result.ok) throw new Error("expected ok");

    const request = (
      await database.db
        .select()
        .from(generationRequests)
        .where(eq(generationRequests.id, result.data.requestId))
    ).at(0);
    expect(request).toMatchObject({
      ownerId: USER_A,
      mode: "topic",
      inputKind: "form",
      status: "queued",
      jobId: result.data.jobId,
      params: {
        grade: 8,
        topicId: "44444444-4444-4444-8444-444444444444",
        topicStableKey: "spldv",
        topicTitle: "SPLDV",
        curriculumVersionId: VERSION,
        type: "multiple_choice",
        quantity: 5,
        difficulty: "sedang",
      },
    });

    const job = (
      await database.db.select().from(jobs).where(eq(jobs.id, result.data.jobId))
    ).at(0);
    expect(job).toMatchObject({
      ownerId: USER_A,
      type: "generate_batch",
      status: "queued",
      payload: { requestId: result.data.requestId },
    });
    expect(job?.runAfter.getTime()).toBe(NOW.getTime());
  });

  it("creates a deferred request and job with a resume time when the budget cannot afford it", async () => {
    const spentAt = new Date(NOW.getTime() - 20 * 3_600_000);
    await database.db.insert(aiCalls).values({
      ownerId: USER_B,
      task: "generate_questions",
      provider: "groq",
      model: "openai/gpt-oss-120b",
      promptVersion: "v1",
      outcome: "ok",
      inputTokens: 100_000,
      outputTokens: 95_000,
      createdAt: spentAt,
    });
    const result = await createGenerationRequest(database.db, input());
    if (!result.ok) throw new Error("expected ok");
    const resumeAt = new Date(spentAt.getTime() + 86_400_000);
    expect(result.data.deferredUntil).toEqual(resumeAt);

    const request = (
      await database.db
        .select()
        .from(generationRequests)
        .where(eq(generationRequests.id, result.data.requestId))
    ).at(0);
    expect(request?.status).toBe("deferred");
    const job = (
      await database.db.select().from(jobs).where(eq(jobs.id, result.data.jobId))
    ).at(0);
    expect(job?.status).toBe("deferred");
    expect(job?.runAfter.getTime()).toBe(resumeAt.getTime());
  });

  it("refuses a second request while one is active and returns the active id", async () => {
    const first = await createGenerationRequest(database.db, input());
    if (!first.ok) throw new Error("expected ok");
    const second = await createGenerationRequest(database.db, input());
    expect(second).toEqual({
      ok: false,
      error: { reason: "active_request", requestId: first.data.requestId },
    });
    expect(await database.db.select().from(generationRequests)).toHaveLength(1);
    expect(await database.db.select().from(jobs)).toHaveLength(1);
  });

  it("allows a new request once the previous one has finished", async () => {
    const first = await createGenerationRequest(database.db, input());
    if (!first.ok) throw new Error("expected ok");
    await database.db
      .update(generationRequests)
      .set({ status: "succeeded" })
      .where(eq(generationRequests.id, first.data.requestId));
    const second = await createGenerationRequest(database.db, input());
    expect(second.ok).toBe(true);
  });

  it("does not let another teacher's active request block this teacher", async () => {
    const other = await createGenerationRequest(database.db, input({ ownerId: USER_B }));
    expect(other.ok).toBe(true);
    const mine = await createGenerationRequest(database.db, input());
    expect(mine.ok).toBe(true);
  });

  it.each(["failed", "succeeded", "cancelled"] as const)(
    "does not block a new submission once the linked job is %s",
    async (jobStatus) => {
      const first = await createGenerationRequest(database.db, input());
      if (!first.ok) throw new Error("expected ok");
      await database.db
        .update(jobs)
        .set({ status: jobStatus })
        .where(eq(jobs.id, first.data.jobId));
      const second = await createGenerationRequest(database.db, input());
      expect(second.ok).toBe(true);
    },
  );

  it("blocks a new submission while the linked job is running", async () => {
    const first = await createGenerationRequest(database.db, input());
    if (!first.ok) throw new Error("expected ok");
    await database.db
      .update(jobs)
      .set({ status: "running" })
      .where(eq(jobs.id, first.data.jobId));
    const second = await createGenerationRequest(database.db, input());
    expect(second).toEqual({
      ok: false,
      error: { reason: "active_request", requestId: first.data.requestId },
    });
  });

  it("blocks a new submission while a deferred request is waiting", async () => {
    await database.db.insert(aiCalls).values({
      ownerId: USER_B,
      task: "generate_questions",
      provider: "groq",
      model: "openai/gpt-oss-120b",
      promptVersion: "v1",
      outcome: "ok",
      inputTokens: 100_000,
      outputTokens: 95_000,
      createdAt: new Date(NOW.getTime() - 20 * 3_600_000),
    });
    const first = await createGenerationRequest(database.db, input());
    if (!first.ok) throw new Error("expected ok");
    expect(first.data.deferredUntil).not.toBeNull();
    const second = await createGenerationRequest(database.db, input());
    expect(second).toEqual({
      ok: false,
      error: { reason: "active_request", requestId: first.data.requestId },
    });
  });

  it("rolls the whole transaction back when the job cannot be created", async () => {
    await database.db.execute(
      `
      create function p109_boom() returns trigger language plpgsql as $$
      begin raise exception 'boom'; end $$;
    `,
    );
    await database.db.execute(
      `create trigger p109_boom before insert on jobs for each row execute function p109_boom()`,
    );
    try {
      const failure = await createGenerationRequest(database.db, input()).catch(
        (error: unknown) => error,
      );
      // Drizzle wraps the driver error as "Failed query", so the trigger's message is on the cause.
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).cause).toMatchObject({
        message: expect.stringMatching(/boom/) as unknown,
      });
      expect(await database.db.select().from(generationRequests)).toHaveLength(0);
      expect(await database.db.select().from(jobs)).toHaveLength(0);
    } finally {
      await database.db.execute(`drop trigger p109_boom on jobs`);
      await database.db.execute(`drop function p109_boom()`);
    }
  });
});

// Seeds finished requests (no active job) that spent `quantity` questions at `createdAt`.
async function seedRequested(
  ownerId: string,
  quantity: number,
  createdAt: Date,
  status = "succeeded",
) {
  await database.db.insert(generationRequests).values({
    ownerId,
    status,
    params: { quantity },
    createdAt,
  });
}

describe("per-user daily question limit", () => {
  // 10 Nov 2026 12:00 UTC is 19:00 Jakarta on 10 Nov, so the day started 09 Nov 17:00 UTC.
  const TODAY = new Date("2026-11-10T12:00:00.000Z");
  const DAY_START = new Date("2026-11-09T17:00:00.000Z");

  it("allows 4 more when 26 are already requested today, but not 5", async () => {
    await seedRequested(USER_A, 26, new Date("2026-11-10T03:00:00.000Z"));
    const five = await createGenerationRequest(
      database.db,
      input({ now: TODAY, quantity: 5 }),
    );
    expect(five).toEqual({
      ok: false,
      error: {
        reason: "daily_limit",
        limit: USER_DAILY_QUESTION_LIMIT,
        used: 26,
        remaining: 4,
        resetsAt: new Date("2026-11-10T17:00:00.000Z"),
      },
    });
    expect(await database.db.select().from(jobs)).toHaveLength(0);

    const four = await createGenerationRequest(
      database.db,
      input({ now: TODAY, quantity: 4 }),
    );
    expect(four.ok).toBe(true);
  });

  it("counts failed and cancelled requests, since they spent quota", async () => {
    await seedRequested(USER_A, 20, DAY_START, "failed");
    await seedRequested(USER_A, 10, DAY_START, "cancelled");
    expect(await questionsRequestedToday(database.db, USER_A, TODAY)).toBe(30);
    const result = await createGenerationRequest(
      database.db,
      input({ now: TODAY, quantity: 1 }),
    );
    expect(result).toMatchObject({ ok: false, error: { reason: "daily_limit" } });
  });

  it("resets at 00:00 Asia/Jakarta", async () => {
    const before = new Date("2026-11-10T16:59:59.000Z"); // 23:59:59 Jakarta
    const after = new Date("2026-11-10T17:00:00.000Z"); // 00:00:00 Jakarta, next day
    await seedRequested(USER_A, 30, new Date("2026-11-10T01:00:00.000Z"));

    const blocked = await createGenerationRequest(
      database.db,
      input({ now: before, quantity: 1 }),
    );
    expect(blocked).toMatchObject({
      ok: false,
      error: { reason: "daily_limit", resetsAt: after },
    });

    const allowed = await createGenerationRequest(
      database.db,
      input({ now: after, quantity: 5 }),
    );
    expect(allowed.ok).toBe(true);
  });

  it("does not count a request made just before midnight Jakarta in the next day", async () => {
    await seedRequested(USER_A, 30, new Date("2026-11-10T16:59:59.000Z"));
    expect(
      await questionsRequestedToday(
        database.db,
        USER_A,
        new Date("2026-11-10T17:00:00.000Z"),
      ),
    ).toBe(0);
  });

  it("does not count another user's requests", async () => {
    await seedRequested(USER_B, 30, new Date("2026-11-10T03:00:00.000Z"));
    expect(await questionsRequestedToday(database.db, USER_A, TODAY)).toBe(0);
    const mine = await createGenerationRequest(
      database.db,
      input({ now: TODAY, quantity: 5 }),
    );
    expect(mine.ok).toBe(true);
  });

  // The lock serialises the two; the second then sees the first as its active request, so this
  // shows the serialisation, not the limit (the next test covers the limit after the lock).
  it("lets exactly one of two parallel submissions through; the other sees it as active", async () => {
    await seedRequested(USER_A, 25, new Date("2026-11-10T03:00:00.000Z"));
    const results = await Promise.all([
      createGenerationRequest(database.db, input({ now: TODAY, quantity: 3 })),
      createGenerationRequest(database.db, input({ now: TODAY, quantity: 3 })),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({
      ok: false,
      error: { reason: "active_request" },
    });
    expect(await questionsRequestedToday(database.db, USER_A, TODAY)).toBe(28);
    expect(await database.db.select().from(jobs)).toHaveLength(1);
  });

  it("serialises the count against the limit even when the first request already finished", async () => {
    await seedRequested(USER_A, 28, new Date("2026-11-10T03:00:00.000Z"));
    const first = await createGenerationRequest(
      database.db,
      input({ now: TODAY, quantity: 2 }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected ok");
    await database.db
      .update(jobs)
      .set({ status: "succeeded" })
      .where(eq(jobs.id, first.data.jobId));
    const second = await createGenerationRequest(
      database.db,
      input({ now: TODAY, quantity: 1 }),
    );
    expect(second).toMatchObject({
      ok: false,
      error: { reason: "daily_limit", used: 30, remaining: 0 },
    });
  });

  it.each([0, 6, -1, 2.5, Number.NaN])(
    "refuses a quantity of %s outright, writing nothing",
    async (quantity) => {
      await expect(
        createGenerationRequest(database.db, input({ now: TODAY, quantity })),
      ).rejects.toThrow(RangeError);
      expect(await database.db.select().from(generationRequests)).toEqual([]);
      expect(await database.db.select().from(jobs)).toEqual([]);
    },
  );

  it("keeps the active-request answer when a request is still running", async () => {
    const first = await createGenerationRequest(
      database.db,
      input({ now: TODAY, quantity: 5 }),
    );
    if (!first.ok) throw new Error("expected ok");
    const second = await createGenerationRequest(
      database.db,
      input({ now: TODAY, quantity: 5 }),
    );
    expect(second).toEqual({
      ok: false,
      error: { reason: "active_request", requestId: first.data.requestId },
    });
  });
});
