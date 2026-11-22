import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  aiCalls,
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
  verificationRuns,
} from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { persistDrafts, type AnyDb } from "./persist";
import { multipleChoiceQuestionSchema } from "../schema/schemas";
import { questionJson, seedCurriculum, seedGenerationRequest } from "./test-support";
import {
  insertRegenerationMarker,
  insertVerificationRun,
  listCurrentVersions,
  persistRegeneratedVersion,
} from "./verify-persist";

let database: TestDatabase;
const NOW = new Date("2026-10-11T10:00:00.000Z");
const db = () => database.db as unknown as AnyDb;

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

async function seedDrafts(count: number, owner = USER_A) {
  const c = await seedCurriculum(database.db);
  const { requestId } = await seedGenerationRequest(database.db, {
    ownerId: owner,
    ...c,
  });
  const saved = await database.db.transaction(async (tx) =>
    persistDrafts(tx as unknown as AnyDb, {
      ownerId: owner,
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
        usage: { inputTokens: 100, outputTokens: 50 },
        latencyMs: 10,
      },
      questions: Array.from({ length: count }, (_, i) =>
        multipleChoiceQuestionSchema.parse(questionJson(i + 1)),
      ),
      now: NOW,
    }),
  );
  return { c, requestId, questionIds: saved.questionIds };
}

describe("listCurrentVersions", () => {
  it("returns the current version of each question with no run yet", async () => {
    const { requestId } = await seedDrafts(2);
    const versions = await listCurrentVersions(db(), { requestId, ownerId: USER_A });
    expect(versions).toHaveLength(2);
    for (const v of versions) {
      expect(v).toMatchObject({
        versionNo: 1,
        status: "belum_dapat_diverifikasi",
        run: null,
        regenerationRecorded: false,
      });
      expect(v.options.map((o) => o.label).sort()).toEqual(["A", "B", "C", "D"]);
      expect(v.answer.correctLabel).toBe("B");
    }
  });

  it("does not return another owner's rows", async () => {
    const { requestId } = await seedDrafts(1);
    expect(await listCurrentVersions(db(), { requestId, ownerId: USER_B })).toEqual([]);
  });

  it("reports the latest real run and a regeneration marker separately", async () => {
    const { requestId } = await seedDrafts(1);
    const [v] = await listCurrentVersions(db(), { requestId, ownerId: USER_A });
    await insertVerificationRun(db(), {
      ownerId: USER_A,
      versionId: v.versionId,
      verifierVersion: "p1-12.1",
      status: "ketidaksesuaian",
      checks: [{ type: "numeric_eval", status: "fail", detail: "salah" }],
      crossCheck: { provider: "groq", model: "m", verdict: "agree" },
      now: NOW,
    });
    await insertRegenerationMarker(db(), {
      ownerId: USER_A,
      versionId: v.versionId,
      now: new Date(NOW.getTime() + 1000),
    });

    const [after] = await listCurrentVersions(db(), { requestId, ownerId: USER_A });
    expect(after.run).toMatchObject({ status: "ketidaksesuaian" });
    expect(after.run!.checks).toEqual([
      { type: "numeric_eval", status: "fail", detail: "salah" },
    ]);
    expect(after.regenerationRecorded).toBe(true);
  });
});

describe("status derivation", () => {
  it("derives the status from the latest real run", async () => {
    const { requestId } = await seedDrafts(1);
    const [v] = await listCurrentVersions(db(), { requestId, ownerId: USER_A });
    const run = (status: "terverifikasi" | "ketidaksesuaian", now: Date) =>
      insertVerificationRun(db(), {
        ownerId: USER_A,
        versionId: v.versionId,
        verifierVersion: "p1-12.1",
        status,
        checks: [],
        crossCheck: null,
        now,
      });
    const statusNow = async () =>
      (await listCurrentVersions(db(), { requestId, ownerId: USER_A }))[0].status;

    await run("terverifikasi", NOW);
    expect(await statusNow()).toBe("terverifikasi");
    const [stored] = await database.db.select().from(questionVersions);
    expect(stored.verificationStatus).toBe("belum_dapat_diverifikasi");

    await run("ketidaksesuaian", new Date(NOW.getTime() + 1000));
    expect(await statusNow()).toBe("ketidaksesuaian");

    await insertRegenerationMarker(db(), {
      ownerId: USER_A,
      versionId: v.versionId,
      now: new Date(NOW.getTime() + 2000),
    });
    expect(await statusNow()).toBe("ketidaksesuaian");
  });
});

describe("persistRegeneratedVersion", () => {
  const input = async () => {
    const { c, requestId, questionIds } = await seedDrafts(1);
    return {
      requestId,
      questionId: questionIds[0],
      args: {
        ownerId: USER_A,
        requestId,
        questionId: questionIds[0],
        topicId: c.topicId,
        sourceRef: c.sourceRef,
        run: {
          provider: "groq",
          model: "openai/gpt-oss-120b",
          promptVersion: "generate-mc.id@1",
          curriculumVersionId: c.versionId,
          usage: { inputTokens: 80, outputTokens: 40 },
          latencyMs: 20,
        },
        question: multipleChoiceQuestionSchema.parse(questionJson(9)),
        difficulty: "sedang" as const,
        now: NOW,
      },
    };
  };

  it("adds version 2, keeps version 1 and moves the current pointer", async () => {
    const { requestId, questionId, args } = await input();
    const saved = await database.db.transaction(async (tx) =>
      persistRegeneratedVersion(tx as unknown as AnyDb, args),
    );

    const versions = await database.db
      .select()
      .from(questionVersions)
      .where(eq(questionVersions.questionId, questionId));
    expect(versions.map((v) => v.versionNo).sort()).toEqual([1, 2]);
    const v2 = versions.find((v) => v.versionNo === 2)!;
    expect(v2).toMatchObject({
      difficulty: "sedang",
      ownerId: USER_A,
      author: "ai",
      changeKind: "regenerated",
      verificationStatus: "belum_dapat_diverifikasi",
      generationRunId: saved.runId,
      id: saved.versionId,
    });
    expect(v2.stemMd).toBe("Hitung $9 + 9$.");

    const [q] = await database.db
      .select()
      .from(questions)
      .where(eq(questions.id, questionId));
    expect(q.currentVersionId).toBe(v2.id);
    expect(await database.db.select().from(questionSources)).toHaveLength(2);
    expect(await database.db.select().from(generationRuns)).toHaveLength(2);

    const [current] = await listCurrentVersions(db(), { requestId, ownerId: USER_A });
    expect(current).toMatchObject({ versionNo: 2, run: null });
  });

  it("rewrites the search text from the new current version", async () => {
    const { questionId, args } = await input();
    await database.db.transaction(async (tx) =>
      persistRegeneratedVersion(tx as unknown as AnyDb, args),
    );
    const [q] = await database.db
      .select()
      .from(questions)
      .where(eq(questions.id, questionId));
    expect(q.searchText).toMatch(/^hitung 9 \+ 9 [.] /);
    expect(q.searchText).toMatch(/ tp-3$/);
  });

  it("refuses a second regeneration of the same question and leaves nothing behind", async () => {
    const { args } = await input();
    await database.db.transaction(async (tx) =>
      persistRegeneratedVersion(tx as unknown as AnyDb, args),
    );
    await expect(
      database.db.transaction(async (tx) =>
        persistRegeneratedVersion(tx as unknown as AnyDb, args),
      ),
    ).rejects.toThrow();
    expect(await database.db.select().from(generationRuns)).toHaveLength(2);
    const versions = await database.db.select().from(questionVersions);
    expect(versions).toHaveLength(2);
  });
});
