import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  aiCalls,
  cpElements,
  curriculumVersions,
  learningObjectives,
  topics,
  generationRequests,
  jobs,
  materialPages,
  materials,
} from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { seedMaterial, seedPages } from "@/features/materials/fixtures/library";
import { createGenerationRequest, type CreateRequestInput } from "./request";
import { seedCurriculum } from "./test-support";
import { estimateBatchTokens, GENERATE_QUOTA } from "./quota";

let database: TestDatabase;
const NOW = new Date("2026-10-11T10:00:00.000Z");

const input = (over: Partial<CreateRequestInput> = {}): CreateRequestInput => ({
  ownerId: USER_A,
  topic: {
    id: "44444444-4444-4444-8444-444444444444",
    stableKey: "spldv",
    title: "SPLDV",
  },
  curriculumVersionId: "33333333-3333-4333-8333-333333333333",
  quantity: 3,
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
  await database.db.delete(materialPages);
  await database.db.delete(materials);
  await database.db.delete(learningObjectives);
  await database.db.delete(topics);
  await database.db.delete(cpElements);
  await database.db.delete(curriculumVersions);
});

describe("createGenerationRequest from a material", () => {
  it("plans the day's quota with the material tokens a request will carry", async () => {
    const curriculum = await seedCurriculum(database.db);
    const topic = { id: curriculum.topicId, stableKey: "spldv", title: "SPLDV" };
    // The shared budget has room for a 3-question topic batch, not for one carrying material.
    await database.db.insert(aiCalls).values({
      ownerId: USER_B,
      task: "generate_questions",
      provider: "groq",
      model: GENERATE_QUOTA.model,
      promptVersion: "generate-mc.id@2",
      inputTokens: GENERATE_QUOTA.perDay - estimateBatchTokens(3) - 10,
      outputTokens: 0,
      outcome: "ok",
      createdAt: new Date(NOW.getTime() - 3_600_000),
    });
    const materialId = await seedMaterial(database, { ownerId: USER_A, pageCount: 1 });
    await seedPages(database, {
      ownerId: USER_A,
      materialId,
      texts: ["SPLDV dua variabel."],
    });

    const fromMaterial = await createGenerationRequest(
      database.db,
      input({
        topic,
        curriculumVersionId: curriculum.versionId,
        material: { materialId, scope: "all" },
      }),
    );
    expect(fromMaterial.ok && fromMaterial.data.deferredUntil).toBeInstanceOf(Date);
    const fromTopic = await createGenerationRequest(
      database.db,
      input({ ownerId: USER_B, topic, curriculumVersionId: curriculum.versionId }),
    );
    expect(fromTopic.ok && fromTopic.data.deferredUntil).toBeNull();
  });

  it("refuses a material whose chosen pages do not match the topic", async () => {
    const curriculum = await seedCurriculum(database.db);
    const materialId = await seedMaterial(database, { ownerId: USER_A, pageCount: 1 });
    await seedPages(database, {
      ownerId: USER_A,
      materialId,
      texts: ["Sejarah Majapahit."],
    });
    expect(
      await createGenerationRequest(
        database.db,
        input({
          topic: { id: curriculum.topicId, stableKey: "spldv", title: "SPLDV" },
          curriculumVersionId: curriculum.versionId,
          material: { materialId, scope: "all" },
        }),
      ),
    ).toEqual({ ok: false, error: { reason: "material", error: "unrelated" } });
  });

  it("stores the selection with the request in material mode", async () => {
    const materialId = await seedMaterial(database, { ownerId: USER_A, pageCount: 2 });
    await seedPages(database, { ownerId: USER_A, materialId, texts: ["a", "b"] });
    const result = await createGenerationRequest(
      database.db,
      input({ material: { materialId, scope: "pages", pages: [2] } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [row] = await database.db
      .select()
      .from(generationRequests)
      .where(eq(generationRequests.id, result.data.requestId));
    expect(row.mode).toBe("material");
    expect(row.sourceSelection).toEqual({ materialId, scope: "pages", pages: [2] });
    expect(row.params).toMatchObject({ quantity: 3, topicStableKey: "spldv" });
  });

  it("refuses another teacher's material, a trashed one and unprocessed pages; nothing is created", async () => {
    const foreign = await seedMaterial(database, { ownerId: USER_B, pageCount: 1 });
    await seedPages(database, { ownerId: USER_B, materialId: foreign, texts: ["a"] });
    const trashed = await seedMaterial(database, {
      ownerId: USER_A,
      pageCount: 1,
      deletedAt: new Date("2026-10-10T00:00:00.000Z"),
      purgeAfter: new Date("2026-11-09T00:00:00.000Z"),
    });
    await seedPages(database, { ownerId: USER_A, materialId: trashed, texts: ["a"] });
    const blank = await seedMaterial(database, { ownerId: USER_A, pageCount: 2 });
    await seedPages(database, { ownerId: USER_A, materialId: blank, texts: ["a", ""] });

    expect(
      await createGenerationRequest(
        database.db,
        input({ material: { materialId: foreign, scope: "all" } }),
      ),
    ).toEqual({ ok: false, error: { reason: "material", error: "material" } });
    expect(
      await createGenerationRequest(
        database.db,
        input({ material: { materialId: trashed, scope: "all" } }),
      ),
    ).toEqual({ ok: false, error: { reason: "material", error: "material" } });
    expect(
      await createGenerationRequest(
        database.db,
        input({ material: { materialId: blank, scope: "pages", pages: [2] } }),
      ),
    ).toEqual({ ok: false, error: { reason: "material", error: "pages" } });
    expect(await database.db.select().from(generationRequests)).toHaveLength(0);
    expect(await database.db.select().from(jobs)).toHaveLength(0);
  });
});
