import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import {
  aiCalls,
  cpElements,
  curriculumVersions,
  generationRequests,
  generationRuns,
  jobs,
  learningObjectives,
  questions,
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
import {
  multipleChoiceQuestionSchema,
  persistDrafts,
  questionJson,
  seedCurriculum,
  seedGenerationRequest,
  type AnyDb,
} from "@/features/generation";
import { backfillSearchText } from "./backfill-search-text";

let database: TestDatabase;
const NOW = new Date("2026-11-18T10:00:00.000Z");

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
  await d.delete(generationRequests);
  await d.delete(jobs);
  await d.delete(learningObjectives);
  await d.delete(topics);
  await d.delete(cpElements);
  await d.delete(curriculumVersions);
});

async function seed(
  ownerId: string,
  count: number,
  c: Awaited<ReturnType<typeof seedCurriculum>>,
) {
  const { requestId } = await seedGenerationRequest(database.db, {
    ownerId,
    quantity: count,
    ...c,
  });
  const saved = await database.db.transaction(async (tx) =>
    persistDrafts(tx as unknown as AnyDb, {
      ownerId,
      requestId,
      topicId: c.topicId,
      sourceRef: c.sourceRef,
      grade: 8,
      difficulty: "sedang",
      run: {
        provider: "groq",
        model: "openai/gpt-oss-120b",
        promptVersion: "generate-mc.id@1",
        curriculumVersionId: c.versionId,
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 5,
      },
      questions: Array.from({ length: count }, (_, i) =>
        multipleChoiceQuestionSchema.parse(questionJson(i + 1)),
      ),
      now: NOW,
    }),
  );
  return saved.questionIds;
}

const textOf = async (id: string) =>
  (await database.db.select().from(questions).where(eq(questions.id, id)))[0]?.searchText;

describe("backfillSearchText", () => {
  it("fills every empty row across owners, in batches, and reports the count", async () => {
    const c = await seedCurriculum(database.db);
    const ids = [...(await seed(USER_A, 3, c)), ...(await seed(USER_B, 2, c))];
    await database.db.update(questions).set({ searchText: "" });

    const filled = await backfillSearchText(database.db, {
      batchSize: 2,
    });

    expect(filled).toBe(5);
    for (const id of ids) {
      const text = await textOf(id);
      expect(text).toMatch(/^hitung \d \+ \d [.] /);
      expect(text).toMatch(/ tp-3$/);
    }
  });

  it("is idempotent and only touches rows whose search text is empty", async () => {
    const c = await seedCurriculum(database.db);
    const [kept, empty] = await seed(USER_A, 2, c);
    await database.db
      .update(questions)
      .set({ searchText: "kept as is" })
      .where(eq(questions.id, kept));
    await database.db
      .update(questions)
      .set({ searchText: "" })
      .where(eq(questions.id, empty));

    const db = database.db as unknown as AnyDb;
    expect(await backfillSearchText(db)).toBe(1);
    expect(await textOf(kept)).toBe("kept as is");
    expect(await textOf(empty)).toMatch(/^hitung 2 \+ 2 [.] /);

    const before = await textOf(empty);
    expect(await backfillSearchText(db)).toBe(0);
    expect(await textOf(empty)).toBe(before);
  });

  it("leaves a question without a current version empty and still finishes", async () => {
    const c = await seedCurriculum(database.db);
    const [noVersion, withVersion] = await seed(USER_A, 2, c);
    await database.db
      .update(questions)
      .set({ searchText: "" })
      .where(inArray(questions.id, [noVersion, withVersion]));
    await database.db.execute(
      sql`update questions set current_version_id = null where id = ${noVersion}`,
    );

    expect(await backfillSearchText(database.db as unknown as AnyDb)).toBe(1);
    expect(await textOf(noVersion)).toBe("");
    expect(await textOf(withVersion)).not.toBe("");
  });

  it("stops after maxBatches and the next call continues where the rows are left", async () => {
    const c = await seedCurriculum(database.db);
    const ids = await seed(USER_A, 5, c);
    await database.db.update(questions).set({ searchText: "" });
    const db = database.db as unknown as AnyDb;

    expect(await backfillSearchText(db, { batchSize: 2, maxBatches: 1 })).toBe(2);
    const empty = async () =>
      (await Promise.all(ids.map(textOf))).filter((text) => text === "").length;
    expect(await empty()).toBe(3);
    expect(await backfillSearchText(db, { batchSize: 2 })).toBe(3);
    expect(await empty()).toBe(0);
  });

  it("starts no batch once out of time, and the next call continues", async () => {
    const c = await seedCurriculum(database.db);
    await seed(USER_A, 5, c);
    await database.db.update(questions).set({ searchText: "" });
    const db = database.db as unknown as AnyDb;
    let batches = 0;
    const onOutOfTime = vi.fn();
    expect(
      await backfillSearchText(db, {
        batchSize: 2,
        outOfTime: () => batches++ >= 1,
        onOutOfTime,
      }),
    ).toBe(2);
    expect(onOutOfTime).toHaveBeenCalledTimes(1);
    expect(await backfillSearchText(db, { batchSize: 2 })).toBe(3);
  });

  it("marks text that normalises to nothing so it is not read again", async () => {
    const c = await seedCurriculum(database.db);
    const [id] = await seed(USER_A, 1, c);
    // question_versions is immutable by trigger; the fixture bypasses it to build the odd row.
    await database.db.execute(sql`alter table question_versions disable trigger user`);
    await database.db.execute(
      sql`update question_versions set stem_md = '$\\alpha$', options = '[]'::jsonb, explanation_md = '$$'`,
    );
    await database.db.execute(sql`alter table question_versions enable trigger user`);
    await database.db.delete(learningObjectives);
    await database.db.update(questions).set({ searchText: "" });
    const db = database.db as unknown as AnyDb;

    expect(await backfillSearchText(db)).toBe(1);
    expect(await textOf(id)).toBe(" ");
    expect(await backfillSearchText(db)).toBe(0);
  });
});
