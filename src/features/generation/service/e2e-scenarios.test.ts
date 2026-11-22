import { asc, eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createRuntimeGateway } from "@/lib/ai/runtime";
import {
  getE2eAiState,
  resetE2eAi,
  setScenario,
  type Scenario,
} from "@/lib/ai/e2e/control";
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
import { createGenerateBatchHandler } from "./generate-batch";
import { buildContext, seedCurriculum, seedGenerationRequest } from "./test-support";

// The REAL generate_batch handler (generation, solver cross-check, one-question regeneration)
// against PGlite, with the gateway built by createRuntimeGateway while the e2e fake AI is on:
// this pins what each scripted scenario produces and covers the runtime wiring itself.

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
  vi.stubEnv("E2E_FAKE_AI", "1");
  vi.stubEnv("NODE_ENV", "development");
  resetE2eAi();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetE2eAi();
});

function handlerWithRuntimeGateway() {
  return createGenerateBatchHandler({
    db: database.db,
    createGateway: (budget) => createRuntimeGateway(budget),
    now: () => NOW,
  });
}

async function start(scenario: Scenario, quantity = 5) {
  setScenario(scenario);
  const c = await seedCurriculum(database.db);
  const seeded = await seedGenerationRequest(database.db, {
    ownerId: USER_A,
    quantity,
    ...c,
  });
  return { ...seeded, handler: handlerWithRuntimeGateway() };
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

// question_versions is immutable: a version's status is its latest real verification run (a
// regeneration marker row is not a run). Stored spelling of the cross-check is dicek_silang_ai.
async function currentStatuses(): Promise<{ questionId: string; status: string }[]> {
  const versions = await database.db
    .select()
    .from(questionVersions)
    .orderBy(asc(questionVersions.createdAt), asc(questionVersions.versionNo));
  const byQuestion = new Map<string, { id: string; versionNo: number }>();
  for (const version of versions) {
    const seen = byQuestion.get(version.questionId);
    if (!seen || version.versionNo > seen.versionNo) {
      byQuestion.set(version.questionId, {
        id: version.id,
        versionNo: version.versionNo,
      });
    }
  }
  const result: { questionId: string; status: string }[] = [];
  for (const [questionId, { id }] of byQuestion) {
    const runs = await database.db
      .select()
      .from(verificationRuns)
      .where(eq(verificationRuns.questionVersionId, id))
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
    const status = latest ? latest.status : "belum_dapat_diverifikasi";
    result.push({
      questionId,
      status: status === "dicek_silang_ai" ? "dicek_silang" : status,
    });
  }
  return result;
}

describe("e2e scenarios against the real generate_batch pipeline", () => {
  it("valid: five drafts, all verified by the cross-check", async () => {
    const { requestId, jobId, handler } = await start("valid");

    const result = await handler(await buildContext(database.db, jobId, { now: NOW }));

    expect(result).toEqual({
      kind: "done",
      progress: { step: "saved", done: 5, total: 5 },
    });
    expect(await database.db.select().from(questions)).toHaveLength(5);
    expect((await currentStatuses()).map((s) => s.status)).toEqual(
      Array(5).fill("terverifikasi"),
    );
    expect(await requestStatus(requestId)).toBe("succeeded");
    // One generate call, five solver calls, nothing regenerated.
    expect(getE2eAiState().calls).toEqual({ generate: 1, regenerate: 0, solver: 5 });
  });

  it("malformed_repairable: the repair call yields five drafts", async () => {
    const { requestId, jobId, handler } = await start("malformed_repairable");

    const result = await handler(await buildContext(database.db, jobId, { now: NOW }));

    expect(result.kind).toBe("done");
    expect(await database.db.select().from(questions)).toHaveLength(5);
    expect(await requestStatus(requestId)).toBe("succeeded");
    expect(getE2eAiState().calls).toEqual({ generate: 2, regenerate: 0, solver: 5 });
  });

  it("malformed_twice: attempt 1 is retryable invalid_output and the request is not failed yet", async () => {
    const { requestId, jobId, handler } = await start("malformed_twice");

    await expect(
      handler(
        await buildContext(database.db, jobId, {
          now: NOW,
          attempts: 0,
          maxAttempts: 3,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_output" });

    expect(await requestStatus(requestId)).not.toBe("failed");
    expect(await database.db.select().from(questions)).toHaveLength(0);
    expect(getE2eAiState().calls).toEqual({ generate: 2, regenerate: 0, solver: 0 });

    // The queue re-runs the job: attempt 2 is still invalid_output (not provider_unavailable).
    await expect(
      handler(
        await buildContext(database.db, jobId, {
          now: NOW,
          attempts: 1,
          maxAttempts: 3,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_output" });
    expect(await requestStatus(requestId)).not.toBe("failed");
    expect(getE2eAiState().calls.generate).toBe(4);
  });

  it("malformed_twice: the final attempt fails the request with the invalid-output code", async () => {
    const { requestId, jobId, handler } = await start("malformed_twice");

    await expect(
      handler(
        await buildContext(database.db, jobId, {
          now: NOW,
          attempts: 2,
          maxAttempts: 3,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_output" });

    expect(await database.db.select().from(questions)).toHaveLength(0);
    expect(await requestStatus(requestId)).toBe("failed");
    expect(getE2eAiState().calls).toEqual({ generate: 2, regenerate: 0, solver: 0 });
  });

  it("wrong_key_persistent: question 1 is regenerated once and stays contradicted", async () => {
    const { requestId, jobId, handler } = await start("wrong_key_persistent");

    const result = await handler(await buildContext(database.db, jobId, { now: NOW }));

    expect(result.kind).toBe("done");
    expect(await requestStatus(requestId)).toBe("succeeded");
    const statuses = (await currentStatuses()).map((s) => s.status);
    expect(statuses.filter((s) => s === "ketidaksesuaian")).toHaveLength(1);
    expect(statuses.filter((s) => s === "terverifikasi")).toHaveLength(4);
    const versions = await database.db.select().from(questionVersions);
    expect(versions.map((v) => v.versionNo).sort()).toEqual([1, 1, 1, 1, 1, 2]);
    // generate, five solver calls, one regeneration, one solver call for the replacement.
    expect(getE2eAiState().calls).toEqual({ generate: 1, regenerate: 1, solver: 6 });
  });

  it("rate_limited: defers with provider_rate_limited, then completes after the flip", async () => {
    const { requestId, jobId, handler } = await start("rate_limited");

    const first = await handler(await buildContext(database.db, jobId, { now: NOW }));

    expect(first).toMatchObject({
      kind: "defer",
      runAfter: new Date(NOW.getTime() + 60_000),
      progress: { messageKey: "provider_rate_limited" },
    });
    expect(await requestStatus(requestId)).toBe("deferred");
    expect(await database.db.select().from(questions)).toHaveLength(0);
    expect(getE2eAiState().scenario).toBe("valid");

    const second = await handler(await buildContext(database.db, jobId, { now: NOW }));

    expect(second.kind).toBe("done");
    expect(await database.db.select().from(questions)).toHaveLength(5);
    expect(await requestStatus(requestId)).toBe("succeeded");
  });
});
