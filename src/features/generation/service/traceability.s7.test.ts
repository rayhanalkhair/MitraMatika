import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFakeProvider, createGateway, defaultRouting } from "@/lib/ai";
import type { FakeResponse } from "@/lib/ai/providers/fake";
import {
  aiCalls,
  auditLog,
  cpElements,
  curriculumVersions,
  generationRequests,
  generationRuns,
  jobs,
  learningObjectives,
  questions,
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
import { createGenerateBatchHandler } from "./generate-batch";
import type { AnyDb } from "./persist";
import {
  batchJson,
  buildContext,
  questionJson,
  seedCurriculum,
  seedGenerationRequest,
  solverPicking,
  solverWrong,
} from "./test-support";
import { getRequestTraces } from "./trace";

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
  await d.delete(auditLog);
  await d.delete(generationRequests);
  await d.delete(jobs);
  await d.delete(learningObjectives);
  await d.delete(topics);
  await d.delete(cpElements);
  await d.delete(curriculumVersions);
});

const solver = solverPicking;

async function run(quantity: number, responses: FakeResponse[]) {
  const c = await seedCurriculum(database.db);
  const { requestId, jobId } = await seedGenerationRequest(database.db, {
    ownerId: USER_A,
    quantity,
    ...c,
  });
  const provider = createFakeProvider("groq", responses);
  const handler = createGenerateBatchHandler({
    db: database.db,
    createGateway: (budget) =>
      createGateway({ routing: defaultRouting, providers: { groq: provider }, budget }),
    now: () => NOW,
  });
  await handler(await buildContext(database.db, jobId, { now: NOW }));
  return { c, requestId, provider };
}

describe("S7 traceability", () => {
  it("records provider, model, prompt version, curriculum version, generation time and status for every saved question", async () => {
    const { c, requestId } = await run(2, [
      batchJson(2),
      solver("B", "2"),
      solver("B", "4"),
    ]);

    const traces = await getRequestTraces(database.db, {
      ownerId: USER_A,
      requestId,
    });

    expect(traces).toHaveLength(2);
    for (const trace of traces) {
      expect(trace.generation).toMatchObject({
        provider: "groq",
        model: "openai/gpt-oss-120b",
        promptVersion: "generate-mc.id@2",
        curriculumVersionId: c.versionId,
      });
      expect(trace.generation!.ranAt).toEqual(NOW);
      expect(trace.curriculum).toMatchObject({
        versionCode: "v1",
        topicStableKey: "spldv",
        sourceAnchor: c.sourceRef,
      });
      expect(trace.verification.status).toBe("terverifikasi");
      expect(trace.verification.verifierVersion).toBe("p1-12.1");
      expect(trace.verification.crossCheck).toMatchObject({
        model: "openai/gpt-oss-20b",
        verdict: "agree",
      });
    }
  });

  it("records a disagreeing cross-check when the solver genuinely disagrees with the key", async () => {
    const { requestId } = await run(1, [
      batchJson(1),
      solverWrong(),
      batchJson(1),
      solverWrong(),
    ]);

    const [trace] = await getRequestTraces(database.db, {
      ownerId: USER_A,
      requestId,
    });

    expect(trace.verification.status).not.toBe("terverifikasi");
    expect(trace.verification.crossCheck).toMatchObject({ verdict: "disagree" });
  });

  it("shows the lineage of a regenerated question", async () => {
    const failing = {
      ...questionJson(1),
      verification_claims: [{ type: "numeric_eval", expression: "1+1", expected: "99" }],
    };
    const { requestId } = await run(1, [
      JSON.stringify({ questions: [failing] }),
      solver("B", "2"),
      JSON.stringify({ questions: [questionJson(5)] }),
      solver("B", "10"),
    ]);

    const [trace] = await getRequestTraces(database.db, {
      ownerId: USER_A,
      requestId,
    });

    expect(trace).toMatchObject({
      versionNo: 2,
      changeKind: "regenerated",
      verification: { status: "terverifikasi" },
    });
    expect(trace.versions).toEqual([
      { versionNo: 1, changeKind: "generated", status: "ketidaksesuaian" },
      { versionNo: 2, changeKind: "regenerated", status: "terverifikasi" },
    ]);
    expect(trace.generation!.promptVersion).toBe("generate-mc.id@2");
  });

  it("shows nothing of this teacher's questions to another owner", async () => {
    const { requestId } = await run(1, [batchJson(1), solver("B", "2")]);
    expect(
      await getRequestTraces(database.db as unknown as AnyDb, {
        ownerId: USER_A,
        requestId,
      }),
    ).toHaveLength(1);
    expect(
      await getRequestTraces(database.db as unknown as AnyDb, {
        ownerId: USER_B,
        requestId,
      }),
    ).toEqual([]);
  });
});
