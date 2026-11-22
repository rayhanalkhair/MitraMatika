import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiProviderError,
  createFakeProvider,
  createGateway,
  defaultRouting,
} from "@/lib/ai";
import {
  aiCalls,
  appErrors,
  cpElements,
  curriculumVersions,
  generationRequests,
  generationRuns,
  jobs,
  learningObjectives,
  questions,
  questionSources,
  questionVersions,
  topics,
  usageEvents,
  verificationRuns,
} from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { PermanentJobError, RetryableJobError } from "@/lib/jobs/handler";
import { createGenerateBatchHandler } from "./generate-batch";
import { hashSeed } from "./seeded-shuffle";
import { shuffleQuestionOptions } from "./shuffle-options";
import { GENERATE_QUOTA } from "./quota";
import {
  batchJson,
  buildContext,
  questionJson,
  seedCurriculum,
  seedGenerationRequest,
} from "./test-support";
import { logger } from "@/lib/logger";

// Lets one test make persistDrafts fail after it has written its rows (the real function runs, then
// throws), to prove the savepoint rolls the drafts back while the spent tokens are still recorded.
const persistFault = vi.hoisted(() => ({ fail: false }));
vi.mock("./persist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./persist")>();
  return {
    ...actual,
    persistDrafts: async (...args: Parameters<typeof actual.persistDrafts>) => {
      const saved = await actual.persistDrafts(...args);
      if (persistFault.fail) throw new Error("secret database detail");
      return saved;
    },
  };
});

let database: TestDatabase;
const NOW = new Date("2026-10-11T10:00:00.000Z");
const HOUR = 3_600_000;

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await database.client.close();
});

beforeEach(async () => {
  persistFault.fail = false;
  const d = database.db;
  await d.delete(verificationRuns);
  await d.delete(questions);
  await d.delete(generationRuns);
  await d.delete(aiCalls);
  await d.delete(usageEvents);
  await d.delete(appErrors);
  await d.delete(generationRequests);
  await d.delete(jobs);
  await d.delete(learningObjectives);
  await d.delete(topics);
  await d.delete(cpElements);
  await d.delete(curriculumVersions);
});

const primaryOnly = {
  ...defaultRouting,
  generate_questions: [defaultRouting.generate_questions[0]],
};

function setup(responses: (string | Error)[], routing = primaryOnly) {
  const provider = createFakeProvider("groq", responses);
  const handler = createGenerateBatchHandler({
    db: database.db,
    createGateway: (budget) =>
      createGateway({ routing, providers: { groq: provider }, budget }),
    now: () => NOW,
    verify: false,
  });
  return { provider, handler };
}

async function requestStatus(requestId: string) {
  const row = (
    await database.db
      .select({ status: generationRequests.status })
      .from(generationRequests)
      .where(eq(generationRequests.id, requestId))
  ).at(0);
  return row?.status;
}

// A spend by another teacher: the daily budget is shared across owners. ai_calls.job_id is nullable.
async function seedSpend(tokens: number, at: Date) {
  await database.db.insert(aiCalls).values({
    ownerId: USER_B,
    task: "generate_questions",
    provider: "groq",
    model: GENERATE_QUOTA.model,
    promptVersion: "generate-mc.id@2",
    inputTokens: tokens,
    outputTokens: 0,
    outcome: "ok",
    createdAt: at,
  });
}

// Two options that are the same number in different notation (B and C), key and answer agree.
const duplicateOptions = (n: number) => ({
  ...questionJson(n),
  options: [
    { label: "A", text_md: "5" },
    { label: "B", text_md: "0,5" },
    { label: "C", text_md: "1/2" },
    { label: "D", text_md: "7" },
  ],
  correctLabel: "B",
  answer: { display_md: "0,5", machine: "0,5" },
});

// The marked option (A) is not the final answer.
const wrongKey = (n: number) => ({ ...questionJson(n), correctLabel: "A" });

const batchOf = (items: unknown[]) => JSON.stringify({ questions: items });

describe("generate_batch handler", () => {
  it("saves the drafts, records the call and marks the request succeeded", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 3,
      ...c,
    });
    const { handler, provider } = setup([batchJson(3)]);

    const result = await handler(await buildContext(database.db, jobId, { now: NOW }));

    expect(result).toEqual({
      kind: "done",
      progress: { step: "saved", done: 3, total: 3 },
    });
    const qs = await database.db.select().from(questions);
    expect(qs).toHaveLength(3);
    expect(qs.every((q) => q.ownerId === USER_A && q.status === "draft")).toBe(true);
    expect(qs.every((q) => q.generationRequestId === requestId)).toBe(true);
    expect(qs.every((q) => q.currentVersionId !== null)).toBe(true);

    const versions = await database.db.select().from(questionVersions);
    expect(versions).toHaveLength(3);
    expect(
      versions.every((v) => v.verificationStatus === "belum_dapat_diverifikasi"),
    ).toBe(true);
    expect(await database.db.select().from(questionSources)).toHaveLength(3);
    expect(await database.db.select().from(verificationRuns)).toHaveLength(0);

    const calls = await database.db.select().from(aiCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      ownerId: USER_A,
      jobId,
      outcome: "ok",
      provider: "groq",
      model: GENERATE_QUOTA.model,
      promptVersion: "generate-mc.id@2",
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(await database.db.select().from(generationRuns)).toHaveLength(1);
    expect(await requestStatus(requestId)).toBe("succeeded");

    // The prompt carried the topic and its objectives.
    expect(provider.calls[0].prompt).toContain("SPLDV");
    expect(provider.calls[0].prompt).toContain("- TP-3: Tiga");

    const [event] = await database.db.select().from(usageEvents);
    expect(event).toMatchObject({
      ownerId: USER_A,
      event: "generation_completed",
      entityType: "generation_request",
      entityId: requestId,
    });
  });

  it("repairs malformed output once and sums the usage of both attempts", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 3,
      ...c,
    });
    const { handler, provider } = setup(["this is not json", batchJson(3)]);

    const result = await handler(await buildContext(database.db, jobId, { now: NOW }));

    expect(result.kind).toBe("done");
    expect(provider.calls).toHaveLength(2);
    const [call] = await database.db.select().from(aiCalls);
    expect(call).toMatchObject({ inputTokens: 200, outputTokens: 100, outcome: "ok" });
    expect(await requestStatus(requestId)).toBe("succeeded");
  });

  it("saves at most the requested quantity", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 2,
      ...c,
    });
    const { handler } = setup([batchJson(4)]);

    const result = await handler(await buildContext(database.db, jobId, { now: NOW }));

    expect(result).toEqual({
      kind: "done",
      progress: { step: "saved", done: 2, total: 2 },
    });
    expect(await database.db.select().from(questions)).toHaveLength(2);
    expect(await requestStatus(requestId)).toBe("succeeded");
  });

  it("stores the requested difficulty, not the model's", async () => {
    const c = await seedCurriculum(database.db);
    const { jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 1,
      difficulty: "sulit",
      ...c,
    });
    const { handler } = setup([batchJson(1, "mudah")]);

    await handler(await buildContext(database.db, jobId, { now: NOW }));

    const [q] = await database.db.select().from(questions);
    expect(q.difficulty).toBe("sulit");
  });

  it("saves a short batch and marks the request partial", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 5,
      ...c,
    });
    const { handler } = setup([batchJson(3)]);

    const result = await handler(await buildContext(database.db, jobId, { now: NOW }));

    expect(result).toEqual({
      kind: "done",
      progress: { step: "saved", done: 3, total: 5 },
    });
    expect(await database.db.select().from(questions)).toHaveLength(3);
    expect(await requestStatus(requestId)).toBe("partial");
    const [event] = await database.db.select().from(usageEvents);
    expect(event).toMatchObject({
      event: "generation_completed",
      metadata: { requested: 5, returned: 3, status: "partial" },
    });
  });

  it("drops a question with duplicate options and saves the rest as partial", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 5,
      ...c,
    });
    const { handler } = setup([
      batchOf([
        questionJson(1),
        duplicateOptions(2),
        questionJson(3),
        questionJson(4),
        questionJson(5),
      ]),
    ]);

    const result = await handler(await buildContext(database.db, jobId, { now: NOW }));

    expect(result).toEqual({
      kind: "done",
      progress: { step: "saved", done: 4, total: 5 },
    });
    const versions = await database.db.select().from(questionVersions);
    expect(versions).toHaveLength(4);
    expect(versions.map((v) => v.stemMd)).not.toContain("Hitung $2 + 2$.");
    expect(await requestStatus(requestId)).toBe("partial");
    const [event] = await database.db.select().from(usageEvents);
    expect(event).toMatchObject({
      event: "generation_completed",
      metadata: {
        requested: 5,
        returned: 4,
        status: "partial",
        rejected: 1,
        findings: { options_not_distinct: 1 },
      },
    });
  });

  it("drops a question whose marked option is not the final answer", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 2,
      ...c,
    });
    const { handler } = setup([batchOf([questionJson(1), wrongKey(2)])]);

    await handler(await buildContext(database.db, jobId, { now: NOW }));

    const versions = await database.db.select().from(questionVersions);
    expect(versions.map((v) => v.stemMd)).toEqual(["Hitung $1 + 1$."]);
    expect(await requestStatus(requestId)).toBe("partial");
    const [event] = await database.db.select().from(usageEvents);
    expect(event).toMatchObject({
      metadata: { rejected: 1, findings: { key_not_final_answer: 1 } },
    });
  });

  it("lets a surplus valid question fill the place of a rejected one", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 2,
      ...c,
    });
    const { handler } = setup([
      batchOf([wrongKey(1), questionJson(2), questionJson(3), questionJson(4)]),
    ]);

    const result = await handler(await buildContext(database.db, jobId, { now: NOW }));

    expect(result).toEqual({
      kind: "done",
      progress: { step: "saved", done: 2, total: 2 },
    });
    const versions = await database.db.select().from(questionVersions);
    expect(versions.map((v) => v.stemMd).sort()).toEqual([
      "Hitung $2 + 2$.",
      "Hitung $3 + 3$.",
    ]);
    expect(await requestStatus(requestId)).toBe("succeeded");
    const [event] = await database.db.select().from(usageEvents);
    expect(event).toMatchObject({
      metadata: { rejected: 1, findings: { key_not_final_answer: 1 } },
    });
  });

  it("fails the attempt when no question passes, recording the spent tokens", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 2,
      ...c,
    });
    const { handler } = setup([batchOf([duplicateOptions(1), wrongKey(2)])]);

    const error = await handler(
      await buildContext(database.db, jobId, { now: NOW }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Tidak ada soal yang lolos pemeriksaan struktur.",
    );
    expect(error).not.toBeInstanceOf(PermanentJobError);
    expect(await database.db.select().from(questions)).toHaveLength(0);
    expect(await database.db.select().from(questionVersions)).toHaveLength(0);
    expect(await database.db.select().from(generationRuns)).toHaveLength(0);
    const calls = await database.db.select().from(aiCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      ownerId: USER_A,
      jobId,
      outcome: "error",
      errorCode: "structural_failed",
      inputTokens: 100,
      outputTokens: 50,
    });
    // Not the last attempt: the request is left for the retry.
    expect(await requestStatus(requestId)).toBe("running");
    expect(await database.db.select().from(usageEvents)).toHaveLength(0);
  });

  it("marks the request failed on the last attempt when no question passes", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 2,
      ...c,
    });
    const { handler } = setup([batchOf([duplicateOptions(1), wrongKey(2)])]);

    await expect(
      handler(
        await buildContext(database.db, jobId, { now: NOW, attempts: 2, maxAttempts: 3 }),
      ),
    ).rejects.toThrow("Tidak ada soal yang lolos pemeriksaan struktur.");

    expect(await requestStatus(requestId)).toBe("failed");
    const [event] = await database.db.select().from(usageEvents);
    expect(event).toMatchObject({
      event: "generation_failed",
      metadata: {
        code: "structural_failed",
        rejected: 2,
        findings: { options_not_distinct: 1, key_not_final_answer: 1 },
      },
    });
  });

  it("defers without calling the model when the day's budget cannot afford the batch", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 5,
      ...c,
    });
    const spentAt = new Date(NOW.getTime() - HOUR);
    await seedSpend(195_000, spentAt);
    const { handler, provider } = setup([batchJson(5)]);

    const result = await handler(await buildContext(database.db, jobId, { now: NOW }));

    expect(result).toMatchObject({
      kind: "defer",
      runAfter: new Date(spentAt.getTime() + 24 * HOUR),
    });
    expect(provider.calls).toHaveLength(0);
    expect(await requestStatus(requestId)).toBe("deferred");
    expect(await database.db.select().from(questions)).toHaveLength(0);
    // Only the seeded spend row exists; the handler added none.
    expect(await database.db.select().from(aiCalls)).toHaveLength(1);
  });

  it("does not count a spend made exactly 24 hours ago", async () => {
    const c = await seedCurriculum(database.db);
    const { jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 5,
      ...c,
    });
    await seedSpend(199_000, new Date(NOW.getTime() - 24 * HOUR));
    const { handler } = setup([batchJson(5)]);

    const result = await handler(await buildContext(database.db, jobId, { now: NOW }));

    expect(result.kind).toBe("done");
  });

  it("records spent tokens and defers when the repair is not affordable", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 5,
      ...c,
    });
    // One invalid answer; the 5-question repair would exceed the per-minute budget.
    const { handler, provider } = setup(["{}"]);

    const result = await handler(await buildContext(database.db, jobId, { now: NOW }));

    expect(result).toMatchObject({
      kind: "defer",
      runAfter: new Date(NOW.getTime() + 60_000),
    });
    expect(provider.calls).toHaveLength(1);
    const [call] = await database.db.select().from(aiCalls);
    expect(call).toMatchObject({
      ownerId: USER_A,
      outcome: "error",
      errorCode: "repair_deferred",
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(await requestStatus(requestId)).toBe("deferred");
    expect(await database.db.select().from(questions)).toHaveLength(0);
  });

  it("throws a retryable error after invalid output and keeps the request running", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 3,
      ...c,
    });
    const { handler } = setup(["{}", "{}"]);

    await expect(
      handler(await buildContext(database.db, jobId, { now: NOW })),
    ).rejects.toThrow("Keluaran AI tidak valid setelah perbaikan.");

    const [call] = await database.db.select().from(aiCalls);
    expect(call).toMatchObject({
      outcome: "error",
      errorCode: "invalid_output",
      inputTokens: 200,
      outputTokens: 100,
    });
    expect(await requestStatus(requestId)).toBe("running");
    expect(await database.db.select().from(questions)).toHaveLength(0);
  });

  it("marks the request failed on the last attempt", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 3,
      ...c,
    });
    const { handler } = setup([]); // the fake provider throws on the first call

    await expect(
      handler(
        await buildContext(database.db, jobId, { now: NOW, attempts: 2, maxAttempts: 3 }),
      ),
    ).rejects.toThrow("Layanan AI sedang tidak dapat dijangkau.");

    expect(await requestStatus(requestId)).toBe("failed");
    const [call] = await database.db.select().from(aiCalls);
    expect(call).toMatchObject({ outcome: "error", errorCode: "provider_error" });
    const [event] = await database.db.select().from(usageEvents);
    expect(event).toMatchObject({ event: "generation_failed", entityId: requestId });
  });

  it("fails permanently on a policy error", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      ...c,
    });
    const { handler } = setup([], { ...defaultRouting, generate_questions: [] });

    const error = await handler(
      await buildContext(database.db, jobId, { now: NOW }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PermanentJobError);
    expect((error as PermanentJobError).code).toBe("no_eligible_route");
    expect(await requestStatus(requestId)).toBe("failed");
  });

  it("does not call the model again when the drafts already exist", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 2,
      ...c,
    });
    const first = setup([batchJson(2)]);
    await first.handler(await buildContext(database.db, jobId, { now: NOW }));
    // Simulate the lost `complete`: the same job is run again.
    const second = setup([batchJson(2)]);
    const result = await second.handler(
      await buildContext(database.db, jobId, { now: NOW }),
    );

    expect(result).toEqual({
      kind: "done",
      progress: { step: "saved", done: 2, total: 2 },
    });
    expect(second.provider.calls).toHaveLength(0);
    expect(await database.db.select().from(questions)).toHaveLength(2);
    expect(await database.db.select().from(aiCalls)).toHaveLength(1);
    expect(await requestStatus(requestId)).toBe("succeeded");
  });

  it("keeps the spent tokens when the drafts cannot be saved", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 3,
      ...c,
    });
    persistFault.fail = true;
    const { handler } = setup([batchJson(3)]);

    const error = await handler(
      await buildContext(database.db, jobId, { now: NOW, attempts: 2, maxAttempts: 3 }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Draf soal tidak dapat disimpan.");
    expect((error as Error).message).not.toContain("secret");
    // The drafts rolled back with their savepoint.
    expect(await database.db.select().from(questions)).toHaveLength(0);
    expect(await database.db.select().from(questionVersions)).toHaveLength(0);
    expect(await database.db.select().from(questionSources)).toHaveLength(0);
    expect(await database.db.select().from(generationRuns)).toHaveLength(0);
    // The tokens that were spent are still on record, as an error row.
    const calls = await database.db.select().from(aiCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      ownerId: USER_A,
      jobId,
      outcome: "error",
      errorCode: "persist_failed",
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(await requestStatus(requestId)).toBe("failed");
    const [event] = await database.db.select().from(usageEvents);
    expect(event).toMatchObject({ event: "generation_failed", entityId: requestId });
  });

  it("ignores a cancelled request", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      status: "cancelled",
      ...c,
    });
    const { handler, provider } = setup([batchJson(5)]);

    const result = await handler(await buildContext(database.db, jobId, { now: NOW }));

    expect(result.kind).toBe("done");
    expect(provider.calls).toHaveLength(0);
    expect(await database.db.select().from(aiCalls)).toHaveLength(0);
    expect(await requestStatus(requestId)).toBe("cancelled");
  });

  it("defers without calling the model when little time is left", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      ...c,
    });
    const { handler, provider } = setup([batchJson(5)]);

    const ctx = await buildContext(database.db, jobId, { now: NOW, remainingMs: 10_000 });
    const result = await handler(ctx);

    expect(result).toMatchObject({ kind: "defer", runAfter: new Date(ctx.deadline) });
    expect(provider.calls).toHaveLength(0);
    expect(await requestStatus(requestId)).toBe("queued");
  });

  it("defers without calling the model when the lock wait used up the time", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      ...c,
    });
    const provider = createFakeProvider("groq", [batchJson(5)]);
    // The clock reads NOW until the in-lock draft count has run, then jumps past the threshold:
    // the first deadline guard passes (240 s left), the second one (after the lock) must not.
    let late = false;
    const handler = createGenerateBatchHandler({
      db: database.db,
      createGateway: (budget) =>
        createGateway({ routing: primaryOnly, providers: { groq: provider }, budget }),
      now: () => (late ? new Date(NOW.getTime() + 200_000) : NOW),
    });
    const ctx = await buildContext(database.db, jobId, { now: NOW });
    const original = database.db.transaction.bind(database.db);
    const spy = vi.spyOn(database.db, "transaction").mockImplementation(((
      fn: Parameters<typeof original>[0],
      cfg?: never,
    ) =>
      original(async (tx) => {
        // Entering the transaction stands for the time spent waiting for the lock.
        late = true;
        return fn(tx);
      }, cfg)) as typeof original);

    let result;
    try {
      result = await handler(ctx);
    } finally {
      spy.mockRestore();
    }

    expect(result).toMatchObject({ kind: "defer", runAfter: new Date(ctx.deadline) });
    expect(provider.calls).toHaveLength(0);
    expect(await database.db.select().from(aiCalls)).toHaveLength(0);
    expect(await database.db.select().from(questions)).toHaveLength(0);
    expect(await requestStatus(requestId)).toBe("running");
  });

  it("fails the attempt when the repair is refused a second time for the same job", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 5,
      ...c,
    });
    const first = setup(["{}"]);
    const deferred = await first.handler(
      await buildContext(database.db, jobId, { now: NOW }),
    );
    expect(deferred.kind).toBe("defer");

    const second = setup(["{}"]);
    const error = await second
      .handler(await buildContext(database.db, jobId, { now: NOW, attempts: 1 }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentJobError);
    expect((error as Error).message).toBe("Keluaran AI tidak valid setelah perbaikan.");
    const calls = await database.db.select().from(aiCalls);
    expect(calls.map((call) => call.errorCode).sort()).toEqual([
      "invalid_output",
      "repair_deferred",
    ]);
    expect(calls.every((call) => call.ownerId === USER_A && call.jobId === jobId)).toBe(
      true,
    );
    expect(
      calls.every((call) => call.inputTokens === 100 && call.outputTokens === 50),
    ).toBe(true);
    expect(await requestStatus(requestId)).toBe("running"); // not the last attempt
  });

  it("defers when the model lock is not available in time", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      ...c,
    });
    const { handler, provider } = setup([batchJson(5)]);
    const ctx = await buildContext(database.db, jobId, { now: NOW });
    const spy = vi.spyOn(database.db, "transaction").mockRejectedValue(
      Object.assign(new Error("Failed query"), {
        cause: Object.assign(new Error("lock timeout"), { code: "55P03" }),
      }),
    );

    let result;
    try {
      result = await handler(ctx);
    } finally {
      spy.mockRestore();
    }

    expect(result).toMatchObject({ kind: "defer", runAfter: new Date(ctx.deadline) });
    expect(provider.calls).toHaveLength(0);
    expect(await database.db.select().from(aiCalls)).toHaveLength(0);
    expect(await requestStatus(requestId)).toBe("running");
  });

  it("never lets raw database error text reach the stored job error", async () => {
    const c = await seedCurriculum(database.db);
    const { jobId } = await seedGenerationRequest(database.db, { ownerId: USER_A, ...c });
    const { handler } = setup([batchJson(5)]);
    const ctx = await buildContext(database.db, jobId, { now: NOW });
    const spy = vi
      .spyOn(database.db, "transaction")
      .mockRejectedValue(new Error("insert into secret_table values (secret)"));
    const log = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    let error: unknown;
    try {
      error = await handler(ctx).catch((e: unknown) => e);
    } finally {
      spy.mockRestore();
      log.mockRestore();
    }

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentJobError);
    expect((error as Error).message).not.toContain("secret");
    expect((error as Error).message).toBe(
      "Pembuatan soal gagal karena kesalahan sistem.",
    );
  });

  it("records generation_failed with system_error for an unknown error on the last attempt", async () => {
    const c = await seedCurriculum(database.db);
    const { jobId } = await seedGenerationRequest(database.db, { ownerId: USER_A, ...c });
    const { handler } = setup([batchJson(5)]);
    const ctx = await buildContext(database.db, jobId, {
      now: NOW,
      attempts: 2,
      maxAttempts: 3,
    });
    const real = database.db.transaction.bind(database.db);
    let calls = 0;
    const spy = vi
      .spyOn(database.db, "transaction")
      .mockImplementation((...args: Parameters<typeof real>) => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("db down"));
        return real(...args);
      });
    const log = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    let error: unknown;
    try {
      error = await handler(ctx).catch((e: unknown) => e);
    } finally {
      spy.mockRestore();
      log.mockRestore();
    }

    expect(error).toBeInstanceOf(RetryableJobError);
    expect(error).toMatchObject({ code: "system_error" });
    const events = await database.db.select().from(usageEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "generation_failed",
      metadata: { code: "system_error" },
    });
  });

  it("marks a deferred request running when it starts", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      status: "deferred",
      quantity: 1,
      ...c,
    });
    const { handler } = setup([batchJson(1)]);

    await handler(await buildContext(database.db, jobId, { now: NOW }));

    expect(await requestStatus(requestId)).toBe("succeeded");
  });

  describe("trust boundary", () => {
    it("rejects a payload that does not name a request", async () => {
      const c = await seedCurriculum(database.db);
      const { jobId } = await seedGenerationRequest(database.db, {
        ownerId: USER_A,
        ...c,
      });
      await database.db
        .update(jobs)
        .set({ payload: { requestId: "not-a-uuid" } })
        .where(eq(jobs.id, jobId));
      const { handler, provider } = setup([batchJson(5)]);

      const error = await handler(
        await buildContext(database.db, jobId, { now: NOW }),
      ).catch((e: unknown) => e);

      expect(error).toMatchObject({
        name: "PermanentJobError",
        code: "request_not_found",
      });
      expect(provider.calls).toHaveLength(0);
    });

    it("rejects a request that belongs to another owner", async () => {
      const c = await seedCurriculum(database.db);
      const { jobId } = await seedGenerationRequest(database.db, {
        ownerId: USER_A,
        ...c,
      });
      const { handler, provider } = setup([batchJson(5)]);

      // The job context says USER_B owns the job, but the request is USER_A's.
      const error = await handler(
        await buildContext(database.db, jobId, { now: NOW, ownerId: USER_B }),
      ).catch((e: unknown) => e);

      expect(error).toMatchObject({ code: "request_not_found" });
      expect(provider.calls).toHaveLength(0);
      expect(await database.db.select().from(questions)).toHaveLength(0);
    });

    it("rejects a payload that points at the request of another job", async () => {
      const c = await seedCurriculum(database.db);
      const one = await seedGenerationRequest(database.db, { ownerId: USER_A, ...c });
      const two = await seedGenerationRequest(database.db, { ownerId: USER_A, ...c });
      await database.db
        .update(jobs)
        .set({ payload: { requestId: two.requestId } })
        .where(eq(jobs.id, one.jobId));
      const { handler, provider } = setup([batchJson(5)]);

      const error = await handler(
        await buildContext(database.db, one.jobId, { now: NOW }),
      ).catch((e: unknown) => e);

      expect(error).toMatchObject({ code: "request_not_found" });
      expect(provider.calls).toHaveLength(0);
      expect(await requestStatus(two.requestId)).toBe("queued");
    });

    it("rejects malformed params and fails the request", async () => {
      const c = await seedCurriculum(database.db);
      const { requestId, jobId } = await seedGenerationRequest(database.db, {
        ownerId: USER_A,
        params: { quantity: 99 },
        ...c,
      });
      const { handler, provider } = setup([batchJson(5)]);

      const error = await handler(
        await buildContext(database.db, jobId, { now: NOW }),
      ).catch((e: unknown) => e);

      expect(error).toMatchObject({ code: "invalid_params" });
      expect(provider.calls).toHaveLength(0);
      expect(await requestStatus(requestId)).toBe("failed");
    });

    it("fails permanently when the topic is not in the request's version", async () => {
      const c = await seedCurriculum(database.db);
      const { requestId, jobId } = await seedGenerationRequest(database.db, {
        ownerId: USER_A,
        ...c,
        topicId: "99999999-9999-4999-8999-999999999999",
      });
      const { handler, provider } = setup([batchJson(5)]);

      const error = await handler(
        await buildContext(database.db, jobId, { now: NOW }),
      ).catch((e: unknown) => e);

      expect(error).toMatchObject({ code: "topic_not_found" });
      expect(provider.calls).toHaveLength(0);
      expect(await requestStatus(requestId)).toBe("failed");
    });
  });

  it("generates from the request's own curriculum version after a newer one is activated", async () => {
    const v1 = await seedCurriculum(database.db, "v1");
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 1,
      ...v1,
    });
    const v2 = await seedCurriculum(database.db, "v2"); // archives v1
    expect(v2.versionId).not.toBe(v1.versionId);
    const { handler } = setup([batchJson(1)]);

    const result = await handler(await buildContext(database.db, jobId, { now: NOW }));

    expect(result.kind).toBe("done");
    const [q] = await database.db.select().from(questions);
    expect(q).toMatchObject({ topicId: v1.topicId, generationRequestId: requestId });
    const [run] = await database.db.select().from(generationRuns);
    expect(run.curriculumVersionId).toBe(v1.versionId);
  });

  it("writes only rows owned by the job's owner", async () => {
    const c = await seedCurriculum(database.db);
    const a = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 2,
      ...c,
    });
    const b = await seedGenerationRequest(database.db, {
      ownerId: USER_B,
      quantity: 2,
      ...c,
    });
    const { handler } = setup([batchJson(2)]);

    await handler(await buildContext(database.db, a.jobId, { now: NOW }));

    const owners = (rows: { ownerId: string }[]) => new Set(rows.map((r) => r.ownerId));
    expect(owners(await database.db.select().from(questions))).toEqual(new Set([USER_A]));
    expect(owners(await database.db.select().from(questionVersions))).toEqual(
      new Set([USER_A]),
    );
    expect(owners(await database.db.select().from(questionSources))).toEqual(
      new Set([USER_A]),
    );
    expect(owners(await database.db.select().from(generationRuns))).toEqual(
      new Set([USER_A]),
    );
    expect(owners(await database.db.select().from(aiCalls))).toEqual(new Set([USER_A]));
    expect(await requestStatus(b.requestId)).toBe("queued"); // untouched
  });

  const rateLimited = (retryAfterMs?: number) =>
    new AiProviderError("rate_limited", "Layanan AI sedang membatasi permintaan.", {
      status: 429,
      retryAfterMs,
    });

  it("defers a provider 429 and resumes without duplicates", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 2,
      ...c,
    });
    const first = setup([rateLimited(120_000)]);

    const deferred = await first.handler(
      await buildContext(database.db, jobId, { now: NOW }),
    );

    expect(deferred).toMatchObject({
      kind: "defer",
      runAfter: new Date(NOW.getTime() + 120_000),
      progress: { messageKey: "provider_rate_limited" },
    });
    expect(await requestStatus(requestId)).toBe("deferred");
    expect(await database.db.select().from(questions)).toHaveLength(0);
    const [call] = await database.db.select().from(aiCalls);
    expect(call).toMatchObject({
      outcome: "error",
      errorCode: "provider_rate_limited",
      ownerId: USER_A,
      jobId,
    });

    const second = setup([batchJson(2)]);
    const done = await second.handler(
      await buildContext(database.db, jobId, { now: NOW }),
    );
    expect(done.kind).toBe("done");
    expect(await database.db.select().from(questions)).toHaveLength(2);
    expect(await requestStatus(requestId)).toBe("succeeded");
  });

  it("floors a provider retry-after at one minute", async () => {
    const c = await seedCurriculum(database.db);
    const { jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 1,
      ...c,
    });
    const { handler } = setup([rateLimited(5_000)]);
    const result = await handler(await buildContext(database.db, jobId, { now: NOW }));
    expect(result).toMatchObject({
      kind: "defer",
      runAfter: new Date(NOW.getTime() + 60_000),
    });
  });

  it("fails with provider_busy after the cap", async () => {
    const c = await seedCurriculum(database.db);
    const { jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 1,
      ...c,
    });
    for (let i = 0; i < 5; i += 1) {
      await database.db.insert(aiCalls).values({
        ownerId: USER_A,
        jobId,
        task: "generate_questions",
        provider: "groq",
        model: GENERATE_QUOTA.model,
        promptVersion: "generate-mc.id@2",
        inputTokens: 0,
        outputTokens: 0,
        outcome: "error",
        errorCode: "provider_rate_limited",
        createdAt: new Date(NOW.getTime() - (i + 1) * 3_600_000 * 30),
      });
    }
    const { handler } = setup([rateLimited()]);

    const error = await handler(
      await buildContext(database.db, jobId, { now: NOW }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RetryableJobError);
    expect(error).toMatchObject({ code: "provider_busy" });
    expect((error as Error).message).not.toMatch(/429|retry/i);
    const forJob = (await database.db.select().from(aiCalls)).filter(
      (call) => call.jobId === jobId,
    );
    expect(
      forJob.filter((call) => call.errorCode === "provider_rate_limited"),
    ).toHaveLength(5);
    expect(forJob.filter((call) => call.errorCode === "provider_busy")).toHaveLength(1);
  });

  const seedDeferrals = async (jobId: string, count: number) => {
    for (let i = 0; i < count; i += 1) {
      await database.db.insert(aiCalls).values({
        ownerId: USER_A,
        jobId,
        task: "generate_questions",
        provider: "groq",
        model: GENERATE_QUOTA.model,
        promptVersion: "generate-mc.id@2",
        inputTokens: 0,
        outputTokens: 0,
        outcome: "error",
        errorCode: "provider_rate_limited",
        createdAt: new Date(NOW.getTime() - (i + 1) * 3_600_000 * 30),
      });
    }
  };

  it("still defers a provider 429 with four earlier deferrals", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 1,
      ...c,
    });
    await seedDeferrals(jobId, 4);
    const { handler } = setup([rateLimited()]);

    const result = await handler(await buildContext(database.db, jobId, { now: NOW }));

    expect(result).toMatchObject({
      kind: "defer",
      progress: { messageKey: "provider_rate_limited" },
    });
    expect(await requestStatus(requestId)).toBe("deferred");
  });

  it("fails the request with provider_busy on the last attempt after the cap", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 1,
      ...c,
    });
    await seedDeferrals(jobId, 5);
    const { handler } = setup([rateLimited()]);

    const error = await handler(
      await buildContext(database.db, jobId, { now: NOW, attempts: 2, maxAttempts: 3 }),
    ).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "provider_busy" });
    expect(await requestStatus(requestId)).toBe("failed");
    const [event] = await database.db.select().from(usageEvents);
    expect(event).toMatchObject({
      event: "generation_failed",
      metadata: { code: "provider_busy" },
    });
  });

  it("retries a provider outage and fails with provider_unavailable", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 1,
      ...c,
    });
    const outage = new AiProviderError(
      "unavailable",
      "Layanan AI sedang tidak dapat dijangkau.",
      {
        status: 503,
      },
    );
    const { handler } = setup([outage]);

    const error = await handler(
      await buildContext(database.db, jobId, { now: NOW, attempts: 2, maxAttempts: 3 }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RetryableJobError);
    expect(error).toMatchObject({ code: "provider_unavailable" });
    expect(await requestStatus(requestId)).toBe("failed");
    const [call] = await database.db.select().from(aiCalls);
    expect(call).toMatchObject({ outcome: "error", errorCode: "provider_error" });
  });

  it("fails at once with provider_misconfigured on a rejected API key, without retrying", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 1,
      ...c,
    });
    const rejected = new AiProviderError(
      "auth_failed",
      "Layanan AI menolak kunci akses.",
      { status: 401 },
    );
    const { handler } = setup([rejected]);

    // First attempt of three: a retryable error would leave the request alone, a permanent one fails it.
    const error = await handler(
      await buildContext(database.db, jobId, { now: NOW, attempts: 0, maxAttempts: 3 }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PermanentJobError);
    expect(error).toMatchObject({ code: "provider_misconfigured" });
    expect(await requestStatus(requestId)).toBe("failed");
    const [call] = await database.db.select().from(aiCalls);
    expect(call).toMatchObject({ outcome: "error", errorCode: "provider_auth_failed" });
  });

  it("labels a per-minute refusal quota_minute", async () => {
    const c = await seedCurriculum(database.db);
    const { jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 5,
      ...c,
    });
    // One invalid answer; the 5-question repair would exceed the per-minute budget.
    const { handler } = setup(["{}"]);

    const result = await handler(await buildContext(database.db, jobId, { now: NOW }));

    expect(result).toMatchObject({
      kind: "defer",
      runAfter: new Date(NOW.getTime() + 60_000),
      progress: { messageKey: "quota_minute" },
    });
  });

  it("labels a daily refusal quota_daily", async () => {
    const c = await seedCurriculum(database.db);
    const { jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 5,
      ...c,
    });
    await seedSpend(195_000, new Date(NOW.getTime() - HOUR));
    const { handler } = setup([batchJson(5)]);

    const result = await handler(await buildContext(database.db, jobId, { now: NOW }));

    expect(result).toMatchObject({
      kind: "defer",
      progress: { messageKey: "quota_daily" },
    });
  });
});

describe("generate_batch option shuffle", () => {
  it("saves each draft with its options shuffled and the key on the same option text", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 5,
      ...c,
    });
    const { handler } = setup([batchJson(5)]);

    await handler(await buildContext(database.db, jobId, { now: NOW }));

    const versions = await database.db.select().from(questionVersions);
    expect(versions).toHaveLength(5);
    for (const version of versions) {
      const options = version.options as { label: string; text_md: string }[];
      const answer = version.answer as { machine: string; correctLabel: string };
      expect(options.map((o) => o.label)).toEqual(["A", "B", "C", "D"]);
      // The key still points at the option whose text is the answer.
      expect(options.find((o) => o.label === answer.correctLabel)!.text_md).toBe(
        answer.machine,
      );
    }
    // Deterministic: the saved order is the seeded shuffle of the model's question i.
    // A no-op shuffle must fail here: the expected order below is built with the same function,
    // so also compare against the model's own order. At least one question has to have moved
    // (all five unchanged has a chance of about 1 in 8 million).
    const moved = versions.filter((v) => {
      const texts = (v.options as { text_md: string }[]).map((o) => o.text_md);
      const original = questionJson(Number(/\$(\d+) \+/.exec(v.stemMd)![1])).options.map(
        (o) => o.text_md,
      );
      return texts.join("|") !== original.join("|");
    });
    expect(moved.length).toBeGreaterThan(0);

    const byStem = new Map(versions.map((v) => [v.stemMd, v]));
    for (let i = 0; i < 5; i += 1) {
      const original = questionJson(i + 1);
      const expected = shuffleQuestionOptions(
        original as never as Parameters<typeof shuffleQuestionOptions>[0],
        hashSeed(`${requestId}:${String(i)}`),
      );
      expect(byStem.get(original.stem_md)!.options).toEqual(expected.options);
    }
  });
});
