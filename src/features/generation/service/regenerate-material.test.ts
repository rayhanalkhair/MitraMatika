import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createFakeProvider,
  createGateway,
  defaultRouting,
  type RoutingConfig,
} from "@/lib/ai";
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
  materialPages,
  materials,
  materialSections,
  questions,
  questionSources,
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
import { seedMaterial, seedPages } from "@/features/materials/fixtures/library";
import { PermanentJobError } from "@/lib/jobs/handler";
import { createGenerateBatchHandler } from "./generate-batch";
import { createRegenerateQuestionHandler, requestRegeneration } from "./regenerate";
import {
  buildContext,
  questionJson,
  seedCurriculum,
  seedGenerationRequest,
  solverPicking,
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
  await d.delete(auditLog);
  await d.delete(generationRequests);
  await d.delete(jobs);
  await d.delete(materialSections);
  await d.delete(materialPages);
  await d.delete(materials);
  await d.delete(learningObjectives);
  await d.delete(topics);
  await d.delete(cpElements);
  await d.delete(curriculumVersions);
});

const cited = (n: number, citations: string[]) => ({ ...questionJson(n), citations });
const batchOf = (items: unknown[]) => JSON.stringify({ questions: items });

// A C0-only Gemini route listed first for every task: anything not labelled C0 must skip it.
const routing: RoutingConfig = {
  ...defaultRouting,
  solve_independent: [
    { provider: "gemini", model: "gemini-flash", allowedDataClasses: ["C0"] },
    ...defaultRouting.solve_independent,
  ],
};

function gatewayWith(groqResponses: FakeResponse[]) {
  const groq = createFakeProvider("groq", groqResponses);
  const gemini = createFakeProvider("gemini", [solverPicking("B", "2")]);
  return {
    groq,
    gemini,
    createGateway: (budget: Parameters<typeof createGateway>[0]["budget"]) =>
      createGateway({ routing, providers: { groq, gemini }, budget }),
  };
}

// One generated material question (citing page 2), its request's job finished.
async function seedQuestion() {
  const curriculum = await seedCurriculum(database.db);
  const materialId = await seedMaterial(database, {
    ownerId: USER_A,
    title: "Buku SPLDV",
    pageCount: 3,
  });
  await seedPages(database, {
    ownerId: USER_A,
    materialId,
    texts: ["Pengantar.", "SPLDV x + y = 5.", "Latihan SPLDV."],
  });
  const { requestId, jobId } = await seedGenerationRequest(database.db, {
    ownerId: USER_A,
    versionId: curriculum.versionId,
    topicId: curriculum.topicId,
    quantity: 1,
  });
  await database.db
    .update(generationRequests)
    .set({ mode: "material", sourceSelection: { materialId, scope: "all" } })
    .where(eq(generationRequests.id, requestId));
  const first = gatewayWith([batchOf([cited(1, ["P2"])]), solverPicking("B", "2")]);
  await createGenerateBatchHandler({
    db: database.db,
    createGateway: first.createGateway,
    now: () => NOW,
  })(await buildContext(database.db, jobId, { now: NOW }));
  await database.db.update(jobs).set({ status: "succeeded" }).where(eq(jobs.id, jobId));
  const [question] = await database.db
    .select()
    .from(questions)
    .where(eq(questions.generationRequestId, requestId));
  return { questionId: question.id, materialId };
}

async function regenerate(questionId: string, responses: FakeResponse[]) {
  const queued = await requestRegeneration(database.db, {
    ownerId: USER_A,
    questionId,
    hint: null,
    now: NOW,
  });
  if (!queued.ok) throw new Error(`refused: ${queued.error.reason}`);
  const gateway = gatewayWith(responses);
  const result = await createRegenerateQuestionHandler({
    db: database.db,
    createGateway: gateway.createGateway,
    now: () => NOW,
  })(await buildContext(database.db, queued.data.jobId, { now: NOW }));
  const [question] = await database.db
    .select()
    .from(questions)
    .where(eq(questions.id, questionId));
  const sources = await database.db
    .select()
    .from(questionSources)
    .where(
      and(
        eq(questionSources.questionVersionId, question.currentVersionId ?? ""),
        eq(questionSources.kind, "material"),
      ),
    );
  const runs = await database.db
    .select()
    .from(verificationRuns)
    .where(eq(verificationRuns.questionVersionId, question.currentVersionId ?? ""))
    .orderBy(asc(verificationRuns.createdAt));
  return { result, sources, runs, ...gateway };
}

describe("a teacher's regeneration of a material question", () => {
  it("writes from the material, validates the citation, and cross-checks as C2", async () => {
    const { questionId, materialId } = await seedQuestion();
    const { result, sources, groq, gemini } = await regenerate(questionId, [
      batchOf([cited(5, ["P3"])]),
      solverPicking("B", "10"),
    ]);
    expect(result.kind).toBe("done");
    expect(groq.calls[0].prompt).toContain("<<<MATERI");
    expect(groq.calls[0].prompt).toContain("[P3]\nLatihan SPLDV.");
    expect(sources).toEqual([
      expect.objectContaining({ materialId, anchorLabel: "hal. 3" }),
    ]);
    // The C0 Gemini solver never saw the material-derived question.
    expect(gemini.calls).toHaveLength(0);
  });

  it("keeps an invented citation out and leaves the version unverifiable", async () => {
    const { questionId } = await seedQuestion();
    const { sources, runs } = await regenerate(questionId, [
      batchOf([cited(5, ["P99"])]),
      solverPicking("B", "10"),
    ]);
    expect(sources).toHaveLength(0);
    expect(runs.at(-1)?.status).toBe("belum_dapat_diverifikasi");
    expect(runs.at(-1)?.checks).toContainEqual(
      expect.objectContaining({ type: "citation", status: "fail" }),
    );
  });

  it("regenerates without material text once the material is gone, marked deleted", async () => {
    const { questionId, materialId } = await seedQuestion();
    await database.db
      .update(questionSources)
      .set({ excerpt: null, materialId: null })
      .where(eq(questionSources.materialId, materialId));
    await database.db.delete(materials).where(eq(materials.id, materialId));
    const { sources, groq, runs } = await regenerate(questionId, [
      batchOf([questionJson(5)]),
      solverPicking("B", "10"),
    ]);
    expect(groq.calls[0].prompt).not.toContain("<<<MATERI");
    expect(sources).toEqual([expect.objectContaining({ materialId: null })]);
    // The placeholder is no citation: the version is not verified as cited.
    expect(runs.at(-1)?.status).toBe("belum_dapat_diverifikasi");
    expect(runs.at(-1)?.checks).toContainEqual(
      expect.objectContaining({ type: "citation", status: "fail" }),
    );
  });

  it("treats a trashed material as gone", async () => {
    const { questionId, materialId } = await seedQuestion();
    await database.db
      .update(materials)
      .set({ deletedAt: NOW, purgeAfter: new Date(NOW.getTime() + 30 * 86_400_000) })
      .where(eq(materials.id, materialId));
    const { sources, groq } = await regenerate(questionId, [
      batchOf([questionJson(5)]),
      solverPicking("B", "10"),
    ]);
    expect(groq.calls[0].prompt).not.toContain("<<<MATERI");
    expect(sources).toEqual([expect.objectContaining({ materialId: null })]);
  });

  it("refuses, without relabelling the source, when the live material no longer matches", async () => {
    const { questionId, materialId } = await seedQuestion();
    await database.db
      .update(materialPages)
      .set({ textMd: "Sejarah Majapahit." })
      .where(eq(materialPages.materialId, materialId));
    const failure = await regenerate(questionId, [batchOf([questionJson(5)])]).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PermanentJobError);
    expect((failure as PermanentJobError).code).toBe("material_unrelated");
  });

  it("fails closed when a material request's selection cannot be read", async () => {
    const { questionId } = await seedQuestion();
    await database.db
      .update(generationRequests)
      .set({ sourceSelection: { materialId: "nope" } });
    const failure = await regenerate(questionId, [batchOf([questionJson(5)])]).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PermanentJobError);
    expect((failure as PermanentJobError).code).toBe("invalid_params");
  });
});
