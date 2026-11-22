import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/events/recorders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/events/recorders")>()),
  recordAudit: vi.fn(() => Promise.resolve(false)),
}));

import { createFakeProvider, createGateway, defaultRouting } from "@/lib/ai";
import {
  aiCalls,
  auditLog,
  cpElements,
  curriculumVersions,
  generationRequests,
  generationRuns,
  jobs,
  learningObjectives,
  questionVersions,
  questions,
  topics,
  usageEvents,
  verificationRuns,
} from "@/lib/db/schema";
import { recordAudit } from "@/lib/events/recorders";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { createGenerateBatchHandler } from "./generate-batch";
import {
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
  vi.mocked(recordAudit).mockClear();
  const d = database.db;
  await d.delete(verificationRuns);
  await d.delete(questions);
  await d.delete(generationRuns);
  await d.delete(aiCalls);
  await d.delete(usageEvents);
  await d.delete(auditLog);
  await d.delete(generationRequests);
  await d.delete(jobs);
  await d.delete(learningObjectives);
  await d.delete(topics);
  await d.delete(cpElements);
  await d.delete(curriculumVersions);
});

const solver = solverPicking;

describe("audit failure", () => {
  it("changes nothing in the pipeline when the audit recorder reports failure", async () => {
    const failing = {
      ...questionJson(1),
      verification_claims: [{ type: "numeric_eval", expression: "1+1", expected: "99" }],
    };
    const c = await seedCurriculum(database.db);
    const { requestId, jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 1,
      ...c,
    });
    const provider = createFakeProvider("groq", [
      JSON.stringify({ questions: [failing] }),
      solver("B", "2"),
      JSON.stringify({ questions: [questionJson(5)] }),
      solver("B", "10"),
    ]);
    const handler = createGenerateBatchHandler({
      db: database.db,
      createGateway: (budget) =>
        createGateway({ routing: defaultRouting, providers: { groq: provider }, budget }),
      now: () => NOW,
    });

    const result = await handler(await buildContext(database.db, jobId, { now: NOW }));

    expect(result.kind).toBe("done");
    const [request] = await database.db.select().from(generationRequests);
    expect(request.id).toBe(requestId);
    expect(request.status).toBe("succeeded");
    const versions = await database.db.select().from(questionVersions);
    expect(versions).toHaveLength(2);

    const actions = vi.mocked(recordAudit).mock.calls.map((call) => call[1].action);
    expect(actions).toContain("drafts_generated");
    expect(actions).toContain("question_regenerated");
  });

  it("still regenerates when the solver genuinely disagrees with the saved key", async () => {
    const c = await seedCurriculum(database.db);
    const { jobId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      quantity: 1,
      ...c,
    });
    const provider = createFakeProvider("groq", [
      JSON.stringify({ questions: [questionJson(1)] }),
      solverWrong(),
      JSON.stringify({ questions: [questionJson(5)] }),
      solver("B", "10"),
    ]);
    const handler = createGenerateBatchHandler({
      db: database.db,
      createGateway: (budget) =>
        createGateway({ routing: defaultRouting, providers: { groq: provider }, budget }),
      now: () => NOW,
    });

    await handler(await buildContext(database.db, jobId, { now: NOW }));

    const versions = await database.db.select().from(questionVersions);
    expect(versions.map((v) => v.versionNo).sort()).toEqual([1, 2]);
  });
});
