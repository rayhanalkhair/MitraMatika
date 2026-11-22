import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  cpElements,
  curriculumVersions,
  generationRequests,
  generationRuns,
  jobs,
  learningObjectives,
  materialPages,
  materials,
  questions,
  questionSources,
  topics,
  verificationRuns,
} from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { seedMaterial, seedPages } from "@/features/materials/fixtures/library";
import {
  getRequestTraces,
  multipleChoiceQuestionSchema,
  persistDrafts,
  questionJson,
  seedCurriculum,
  seedGenerationRequest,
} from "@/features/generation";
import { getRequestReview } from "./review";

let database: TestDatabase;
const NOW = new Date("2026-11-08T10:00:00.000Z");

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
  await d.delete(generationRequests);
  await d.delete(jobs);
  await d.delete(materialPages);
  await d.delete(materials);
  await d.delete(learningObjectives);
  await d.delete(topics);
  await d.delete(cpElements);
  await d.delete(curriculumVersions);
});

// One material question citing page 2 of "Buku SPLDV".
async function seed() {
  const c = await seedCurriculum(database.db);
  const materialId = await seedMaterial(database, {
    ownerId: USER_A,
    title: "Buku SPLDV",
    pageCount: 2,
  });
  await seedPages(database, { ownerId: USER_A, materialId, texts: ["a", "Halaman dua"] });
  const [page] = await database.db
    .select({ id: materialPages.id })
    .from(materialPages)
    .where(and(eq(materialPages.materialId, materialId), eq(materialPages.pageNo, 2)));
  const { requestId } = await seedGenerationRequest(database.db, {
    ownerId: USER_A,
    quantity: 1,
    ...c,
  });
  await database.db.transaction(async (tx) =>
    persistDrafts(tx, {
      ownerId: USER_A,
      requestId,
      topicId: c.topicId,
      sourceRef: c.sourceRef,
      grade: 8,
      difficulty: "sedang",
      run: {
        provider: "groq",
        model: "openai/gpt-oss-120b",
        promptVersion: "generate-mc.id@3",
        curriculumVersionId: c.versionId,
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 1,
      },
      questions: [multipleChoiceQuestionSchema.parse(questionJson(1))],
      materialSources: [
        [
          {
            materialId,
            materialPageId: page.id,
            sectionId: null,
            anchorLabel: "hal. 2",
            excerpt: "Halaman dua",
          },
        ],
      ],
      now: NOW,
    }),
  );
  return { requestId, materialId, sourceRef: c.sourceRef };
}

describe("material sources in the review", () => {
  it('shows "Sumber: <title>, hal. <n>" with a link to the page, and keeps the curriculum anchor', async () => {
    const { requestId, materialId, sourceRef } = await seed();
    const review = await getRequestReview(database.db, { ownerId: USER_A, requestId });
    expect(review?.questions[0].sources).toEqual([
      {
        title: "Buku SPLDV",
        page: 2,
        href: `/materials/${materialId}?page=2`,
      },
    ]);
    // The curriculum panel still reads the curriculum source, not "hal. 2".
    const [trace] = await getRequestTraces(database.db, { ownerId: USER_A, requestId });
    expect(trace.curriculum?.sourceAnchor).toBe(sourceRef);
  });

  it("keeps the question and its anchor when the material is deleted for good, without a link", async () => {
    const { requestId, materialId } = await seed();
    // The purge clears the excerpt, then the material goes (pages cascade, sources set null).
    await database.db
      .update(questionSources)
      .set({ excerpt: null, materialId: null })
      .where(eq(questionSources.materialId, materialId));
    await database.db.delete(materials).where(eq(materials.id, materialId));

    const review = await getRequestReview(database.db, { ownerId: USER_A, requestId });
    expect(review?.questions).toHaveLength(1);
    expect(review?.questions[0].sources).toEqual([{ title: null, page: 2, href: null }]);
    const [anchor] = await database.db
      .select({ anchorLabel: questionSources.anchorLabel })
      .from(questionSources)
      .where(eq(questionSources.kind, "material"));
    expect(anchor.anchorLabel).toBe("hal. 2");
  });

  it("names a trashed material without linking to it", async () => {
    const { requestId, materialId } = await seed();
    await database.db
      .update(materials)
      .set({ deletedAt: NOW, purgeAfter: new Date("2026-12-08T10:00:00.000Z") })
      .where(eq(materials.id, materialId));
    const review = await getRequestReview(database.db, { ownerId: USER_A, requestId });
    expect(review?.questions[0].sources).toEqual([
      { title: "Buku SPLDV", page: 2, href: null },
    ]);
  });

  it("shows nothing of it to another teacher", async () => {
    const { requestId } = await seed();
    expect(
      await getRequestReview(database.db, { ownerId: USER_B, requestId }),
    ).toBeNull();
  });
});
