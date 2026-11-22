import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AiProviderError,
  createFakeProvider,
  createGateway,
  defaultRouting,
} from "@/lib/ai";
import {
  aiCalls,
  appErrors,
  auditLog,
  cpElements,
  curriculumVersions,
  generationRequests,
  generationRuns,
  jobs,
  learningObjectives,
  questions,
  questionVersions,
  topics,
  usageEvents,
  verificationRuns,
} from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  type TestDatabase,
} from "@/lib/db/test-harness";
import type { FakeResponse } from "@/lib/ai/providers/fake";
import { createGenerateBatchHandler } from "./generate-batch";
import { SOLVE_QUOTA } from "./quota";
import {
  batchJson,
  buildContext,
  questionJson,
  seedCurriculum,
  seedGenerationRequest,
  solverPicking,
  solverWrong,
} from "./test-support";

let database: TestDatabase;
const NOW = new Date("2026-10-11T10:00:00.000Z");

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await database.client.close();
});

beforeEach(async () => {
  const d = database.db;
  await d.delete(verificationRuns);
  await d.delete(questions);
  await d.delete(generationRuns);
  await d.delete(aiCalls);
  await d.delete(usageEvents);
  await d.delete(appErrors);
  await d.delete(auditLog);
  await d.delete(generationRequests);
  await d.delete(jobs);
  await d.delete(learningObjectives);
  await d.delete(topics);
  await d.delete(cpElements);
  await d.delete(curriculumVersions);
});

const solver = solverPicking;
const batchOf = (items: unknown[]) => JSON.stringify({ questions: items });
const failingClaim = (n: number) => ({
  ...questionJson(n),
  verification_claims: [
    { type: "numeric_eval", expression: `${String(n)}+${String(n)}`, expected: "99" },
  ],
});

// The default handler (no `verify` option): verification must be on unless a test turns it off.
function setup(responses: FakeResponse[]) {
  const provider = createFakeProvider("groq", responses);
  const handler = createGenerateBatchHandler({
    db: database.db,
    createGateway: (budget) =>
      createGateway({ routing: defaultRouting, providers: { groq: provider }, budget }),
    now: () => NOW,
  });
  return { provider, handler };
}

// question_versions is immutable: a version's status is its latest real verification run (a
// regeneration marker row is not a run); before any run it is the column's creation value. The
// stored spelling of the cross-checked status is `dicek_silang_ai`.
async function effectiveStatus(versionId: string): Promise<string> {
  const runs = await database.db
    .select()
    .from(verificationRuns)
    .where(eq(verificationRuns.questionVersionId, versionId))
    .orderBy(asc(verificationRuns.createdAt), asc(verificationRuns.id));
  const real = runs.filter(
    (run) =>
      !(
        typeof run.crossCheck === "object" &&
        run.crossCheck !== null &&
        "regeneration" in (run.crossCheck as Record<string, unknown>)
      ),
  );
  const latest = real.at(-1);
  const app = (status: string) =>
    status === "dicek_silang_ai" ? "dicek_silang" : status;
  if (latest) return app(latest.status);
  const [row] = await database.db
    .select()
    .from(questionVersions)
    .where(eq(questionVersions.id, versionId));
  return app(row.verificationStatus);
}

async function effectiveStatuses(): Promise<string[]> {
  const versions = await database.db.select().from(questionVersions);
  return Promise.all(versions.map((v) => effectiveStatus(v.id)));
}

async function completedEvent() {
  const events = await database.db
    .select()
    .from(usageEvents)
    .where(eq(usageEvents.event, "generation_completed"));
  expect(events).toHaveLength(1);
  return events[0];
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

describe("generate_batch with verification", () => {
  it("generates, verifies and completes the request", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 2,
      ...c,
    });
    const { handler, provider } = setup([
      batchJson(2),
      solver("B", "2"),
      solver("B", "4"),
    ]);

    const result = await handler(await buildContext(database.db, jobId, { now: NOW }));

    expect(result).toEqual({
      kind: "done",
      progress: { step: "saved", done: 2, total: 2 },
    });
    expect(provider.calls).toHaveLength(3);
    expect(await effectiveStatuses()).toEqual(["terverifikasi", "terverifikasi"]);
    expect(await database.db.select().from(verificationRuns)).toHaveLength(2);
    expect(await requestStatus(requestId)).toBe("succeeded");
    const event = await completedEvent();
    expect(event).toMatchObject({
      event: "generation_completed",
      metadata: {
        requested: 2,
        returned: 2,
        status: "succeeded",
        verified: {
          terverifikasi: 2,
          dicek_silang: 0,
          belum_dapat_diverifikasi: 0,
          ketidaksesuaian: 0,
        },
        regenerated: 0,
      },
    });
  });

  it("regenerates a contradicted question and reports it", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 1,
      ...c,
    });
    const { handler } = setup([
      batchOf([failingClaim(1)]),
      solver("B", "2"),
      batchOf([questionJson(5)]),
      solver("B", "10"),
    ]);

    await handler(await buildContext(database.db, jobId, { now: NOW }));

    const versions = await database.db.select().from(questionVersions);
    expect(versions.map((v) => v.versionNo).sort()).toEqual([1, 2]);
    // The regenerated version is shuffled too, with its key on the answer's option.
    const second = versions.find((v) => v.versionNo === 2)!;
    const secondOptions = second.options as { label: string; text_md: string }[];
    const secondAnswer = second.answer as { machine: string; correctLabel: string };
    expect(
      secondOptions.find((o) => o.label === secondAnswer.correctLabel)!.text_md,
    ).toBe(secondAnswer.machine);
    expect(await requestStatus(requestId)).toBe("succeeded");
    const event = await completedEvent();
    expect(event).toMatchObject({
      metadata: { regenerated: 1, verified: { terverifikasi: 1, ketidaksesuaian: 0 } },
    });
  });

  it("does not verify a question when the solver genuinely disagrees with the saved key", async () => {
    const c = await seedCurriculum(database.db);
    const { jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 1,
      ...c,
    });
    const { handler } = setup([batchJson(1), solverWrong(), batchJson(1), solverWrong()]);

    await handler(await buildContext(database.db, jobId, { now: NOW }));

    expect(await effectiveStatuses()).not.toContain("terverifikasi");
  });

  it("defers verification when the cross-check budget is exhausted and resumes without regenerating", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 2,
      ...c,
    });
    // The cross-check budget is exhausted: drafts are saved, verification waits.
    await database.db.insert(aiCalls).values({
      ownerId: USER_A,
      task: "solve_independent",
      provider: "groq",
      model: SOLVE_QUOTA.model,
      promptVersion: "solve-independent.id@1",
      inputTokens: 7_500,
      outputTokens: 0,
      outcome: "ok",
      createdAt: new Date(NOW.getTime() - 20_000),
    });
    const first = setup([batchJson(2)]);

    const result = await first.handler(
      await buildContext(database.db, jobId, { now: NOW }),
    );

    expect(result).toMatchObject({
      kind: "defer",
      runAfter: new Date(NOW.getTime() + 60_000),
      progress: { messageKey: "quota_minute" },
    });
    expect(await database.db.select().from(questions)).toHaveLength(2);
    expect(await requestStatus(requestId)).toBe("deferred");
    expect(await database.db.select().from(verificationRuns)).toHaveLength(0);
    // Nothing is verified yet: the versions carry only their creation placeholder.
    expect(await effectiveStatuses()).toEqual([
      "belum_dapat_diverifikasi",
      "belum_dapat_diverifikasi",
    ]);

    // The budget window passes: a re-run verifies without generating again.
    await database.db.delete(aiCalls).where(eq(aiCalls.task, "solve_independent"));
    const second = setup([solver("B", "2"), solver("B", "4")]);
    const resumed = await second.handler(
      await buildContext(database.db, jobId, { now: NOW }),
    );

    expect(resumed.kind).toBe("done");
    expect(second.provider.calls).toHaveLength(2);
    expect(await database.db.select().from(questions)).toHaveLength(2);
    expect(await database.db.select().from(verificationRuns)).toHaveLength(2);
    expect(await requestStatus(requestId)).toBe("succeeded");
  });

  it("re-running a finished job changes nothing", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 1,
      ...c,
    });
    const first = setup([batchJson(1), solver("B", "2")]);
    await first.handler(await buildContext(database.db, jobId, { now: NOW }));

    const again = setup([]);
    const result = await again.handler(
      await buildContext(database.db, jobId, { now: NOW }),
    );

    expect(result.kind).toBe("done");
    expect(again.provider.calls).toHaveLength(0);
    expect(await database.db.select().from(questions)).toHaveLength(1);
    expect(await database.db.select().from(verificationRuns)).toHaveLength(1);
    expect(await requestStatus(requestId)).toBe("succeeded");
    const events = await database.db.select().from(usageEvents);
    expect(events.map((e) => e.event).sort()).toEqual([
      "generation_completed",
      "generation_drafts_saved",
    ]);
  });

  it("records the drafts-saved event at save time and the completion once after the resume", async () => {
    const c = await seedCurriculum(database.db);
    const { jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 2,
      ...c,
    });
    await database.db.insert(aiCalls).values({
      ownerId: USER_A,
      task: "solve_independent",
      provider: "groq",
      model: SOLVE_QUOTA.model,
      promptVersion: "solve-independent.id@1",
      inputTokens: 7_500,
      outputTokens: 0,
      outcome: "ok",
      createdAt: new Date(NOW.getTime() - 20_000),
    });
    const duplicateOptions = {
      ...questionJson(2),
      options: [
        { label: "A", text_md: "5" },
        { label: "B", text_md: "0,5" },
        { label: "C", text_md: "1/2" },
        { label: "D", text_md: "7" },
      ],
      correctLabel: "B",
      answer: { display_md: "0,5", machine: "0,5" },
    };
    const first = setup([batchOf([questionJson(1), duplicateOptions, questionJson(3)])]);

    const deferred = await first.handler(
      await buildContext(database.db, jobId, { now: NOW }),
    );

    expect(deferred.kind).toBe("defer");
    const saved = await database.db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.event, "generation_drafts_saved"));
    expect(saved).toHaveLength(1);
    expect(saved[0].metadata).toMatchObject({
      requested: 2,
      returned: 2,
      rejected: 1,
      findings: { options_not_distinct: 1 },
    });
    expect(await database.db.select().from(usageEvents)).toHaveLength(1);

    await database.db.delete(aiCalls).where(eq(aiCalls.task, "solve_independent"));
    const second = setup([solver("B", "2"), solver("B", "4")]);
    const resumed = await second.handler(
      await buildContext(database.db, jobId, { now: NOW }),
    );

    expect(resumed.kind).toBe("done");
    const events = await database.db.select().from(usageEvents);
    expect(events.map((e) => e.event).sort()).toEqual([
      "generation_completed",
      "generation_drafts_saved",
    ]);
  });

  it("shows a deferred request as running again while its drafts are verified", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 1,
      ...c,
    });
    const savedOnly = createGenerateBatchHandler({
      db: database.db,
      createGateway: (budget) =>
        createGateway({
          routing: defaultRouting,
          providers: { groq: createFakeProvider("groq", [batchJson(1)]) },
          budget,
        }),
      now: () => NOW,
      verify: false,
    });
    await savedOnly(await buildContext(database.db, jobId, { now: NOW }));
    await database.db
      .update(generationRequests)
      .set({ status: "deferred" })
      .where(eq(generationRequests.id, requestId));

    const { handler, provider } = setup([solver("B", "2")]);
    const result = await handler(await buildContext(database.db, jobId, { now: NOW }));

    expect(result.kind).toBe("done");
    expect(provider.calls).toHaveLength(1);
    expect(await requestStatus(requestId)).toBe("succeeded");
    expect(await database.db.select().from(verificationRuns)).toHaveLength(1);
  });

  it("completes as partial when fewer questions than requested were saved and verified", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 3,
      ...c,
    });
    const { handler } = setup([batchJson(2), solver("B", "2"), solver("B", "4")]);

    const result = await handler(await buildContext(database.db, jobId, { now: NOW }));

    expect(result).toEqual({
      kind: "done",
      progress: { step: "saved", done: 2, total: 3 },
    });
    expect(await requestStatus(requestId)).toBe("partial");
  });

  it("defers before verifying when the runner has little time left, and does not fail", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 1,
      ...c,
    });
    // First run (verification off) saves the draft; the second has only 80 s of runner budget.
    const savedOnly = createGenerateBatchHandler({
      db: database.db,
      createGateway: (budget) =>
        createGateway({
          routing: defaultRouting,
          providers: { groq: createFakeProvider("groq", [batchJson(1)]) },
          budget,
        }),
      now: () => NOW,
      verify: false,
    });
    await savedOnly(await buildContext(database.db, jobId, { now: NOW }));
    await database.db
      .update(generationRequests)
      .set({ status: "running" })
      .where(eq(generationRequests.id, requestId));

    const { handler, provider } = setup([solver("B", "2")]);
    const result = await handler(
      await buildContext(database.db, jobId, { now: NOW, remainingMs: 80_000 }),
    );

    expect(result.kind).toBe("defer");
    expect(provider.calls).toHaveLength(0);
    expect(await requestStatus(requestId)).toBe("running");
  });

  it("audits the saved drafts once and does not repeat it on a re-run", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 2,
      ...c,
    });
    const first = setup([batchJson(2), solver("B", "2"), solver("B", "4")]);
    await first.handler(await buildContext(database.db, jobId, { now: NOW }));

    const rows = await database.db.select().from(auditLog);
    const generated = rows.filter((row) => row.action === "drafts_generated");
    expect(generated).toHaveLength(1);
    expect(generated[0]).toMatchObject({
      ownerId: USER_A,
      entityType: "generation_request",
      entityId: requestId,
      metadata: { returned: 2, rejected: 0 },
    });

    const again = setup([]);
    await again.handler(await buildContext(database.db, jobId, { now: NOW }));
    const after = await database.db.select().from(auditLog);
    expect(after.filter((row) => row.action === "drafts_generated")).toHaveLength(1);
  });

  it("does not repeat the drafts audit on a resumed verification", async () => {
    const c = await seedCurriculum(database.db);
    const { jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 2,
      ...c,
    });
    await database.db.insert(aiCalls).values({
      ownerId: USER_A,
      task: "solve_independent",
      provider: "groq",
      model: SOLVE_QUOTA.model,
      promptVersion: "solve-independent.id@1",
      inputTokens: 7_500,
      outputTokens: 0,
      outcome: "ok",
      createdAt: new Date(NOW.getTime() - 20_000),
    });
    const first = setup([batchJson(2)]);
    await first.handler(await buildContext(database.db, jobId, { now: NOW }));
    await database.db.delete(aiCalls).where(eq(aiCalls.task, "solve_independent"));
    const second = setup([solver("B", "2"), solver("B", "4")]);
    await second.handler(await buildContext(database.db, jobId, { now: NOW }));

    const generated = (await database.db.select().from(auditLog)).filter(
      (row) => row.action === "drafts_generated",
    );
    expect(generated).toHaveLength(1);
  });

  it("shows provider_rate_limited when verification is throttled and resumes", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 1,
      ...c,
    });
    const throttled = new AiProviderError(
      "rate_limited",
      "Layanan AI sedang membatasi permintaan.",
      { status: 429, retryAfterMs: 90_000 },
    );
    const first = setup([batchJson(1), throttled]);

    const result = await first.handler(
      await buildContext(database.db, jobId, { now: NOW }),
    );

    expect(result).toMatchObject({
      kind: "defer",
      runAfter: new Date(NOW.getTime() + 90_000),
      progress: { messageKey: "provider_rate_limited" },
    });
    expect(await requestStatus(requestId)).toBe("deferred");

    const second = setup([solver("B", "2")]);
    const done = await second.handler(
      await buildContext(database.db, jobId, { now: NOW }),
    );
    expect(done.kind).toBe("done");
    expect(await requestStatus(requestId)).toBe("succeeded");
    expect(await database.db.select().from(questions)).toHaveLength(1);
  });

  it("labels a verification-phase daily refusal quota_daily", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 1,
      ...c,
    });
    const spentAt = new Date(NOW.getTime() - 3_600_000);
    await database.db.insert(aiCalls).values({
      ownerId: USER_A,
      task: "solve_independent",
      provider: "groq",
      model: SOLVE_QUOTA.model,
      promptVersion: "solve-independent.id@1",
      inputTokens: 199_000,
      outputTokens: 0,
      outcome: "ok",
      createdAt: spentAt,
    });
    const first = setup([batchJson(1)]);

    const result = await first.handler(
      await buildContext(database.db, jobId, { now: NOW }),
    );

    expect(result).toMatchObject({
      kind: "defer",
      runAfter: new Date(spentAt.getTime() + 86_400_000),
      progress: { messageKey: "quota_daily" },
    });
    expect(await requestStatus(requestId)).toBe("deferred");
  });
});
