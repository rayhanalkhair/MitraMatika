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
import {
  countDrafts,
  countProviderDeferrals,
  insertAiCall,
  loadRequest,
  persistDrafts,
  setRequestStatus,
  type AnyDb,
} from "./persist";
import { multipleChoiceQuestionSchema } from "../schema/schemas";
import { questionJson, seedCurriculum, seedGenerationRequest } from "./test-support";

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

describe("loadRequest", () => {
  it("returns the request only for its owner and its own job", async () => {
    const c = await seedCurriculum(database.db);
    const a = await seedGenerationRequest(database.db, { ownerId: USER_A, ...c });
    const other = await seedGenerationRequest(database.db, { ownerId: USER_A, ...c });

    expect(
      await loadRequest(db(), {
        requestId: a.requestId,
        ownerId: USER_A,
        jobId: a.jobId,
      }),
    ).toMatchObject({ id: a.requestId, ownerId: USER_A, jobId: a.jobId });
    expect(
      await loadRequest(db(), {
        requestId: a.requestId,
        ownerId: USER_B,
        jobId: a.jobId,
      }),
    ).toBeNull();
    expect(
      await loadRequest(db(), {
        requestId: a.requestId,
        ownerId: USER_A,
        jobId: other.jobId,
      }),
    ).toBeNull();
  });
});

describe("setRequestStatus", () => {
  it("changes the status only from the allowed ones and only for the owner", async () => {
    const c = await seedCurriculum(database.db);
    const { requestId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      status: "succeeded",
      ...c,
    });
    const read = async () =>
      (
        await database.db
          .select({ status: generationRequests.status })
          .from(generationRequests)
          .where(eq(generationRequests.id, requestId))
      )[0].status;

    await setRequestStatus(db(), {
      requestId,
      ownerId: USER_A,
      status: "running",
      from: ["queued", "deferred"],
      now: NOW,
    });
    expect(await read()).toBe("succeeded"); // not in `from`

    await setRequestStatus(db(), {
      requestId,
      ownerId: USER_B,
      status: "failed",
      now: NOW,
    });
    expect(await read()).toBe("succeeded"); // another owner

    await setRequestStatus(db(), {
      requestId,
      ownerId: USER_A,
      status: "partial",
      now: NOW,
    });
    expect(await read()).toBe("partial");
  });
});

describe("insertAiCall", () => {
  it("stores the tokens, the outcome and the injected time", async () => {
    const c = await seedCurriculum(database.db);
    const { jobId } = await seedGenerationRequest(database.db, { ownerId: USER_A, ...c });
    await insertAiCall(db(), {
      ownerId: USER_A,
      jobId,
      provider: "groq",
      model: "openai/gpt-oss-120b",
      promptVersion: "generate-mc.id@1",
      usage: { inputTokens: 1200, outputTokens: 3400, cachedTokens: 10 },
      latencyMs: 2500,
      outcome: "error",
      errorCode: "invalid_output",
      createdAt: NOW,
    });
    const [row] = await database.db.select().from(aiCalls);
    expect(row).toMatchObject({
      ownerId: USER_A,
      jobId,
      task: "generate_questions",
      provider: "groq",
      model: "openai/gpt-oss-120b",
      promptVersion: "generate-mc.id@1",
      inputTokens: 1200,
      outputTokens: 3400,
      cachedTokens: 10,
      latencyMs: 2500,
      outcome: "error",
      errorCode: "invalid_output",
    });
    expect(row.createdAt.toISOString()).toBe(NOW.toISOString());
  });

  it("stores another task when one is given", async () => {
    const c = await seedCurriculum(database.db);
    const { jobId } = await seedGenerationRequest(database.db, { ownerId: USER_A, ...c });
    await insertAiCall(db(), {
      ownerId: USER_A,
      jobId,
      task: "solve_independent",
      provider: "groq",
      model: "openai/gpt-oss-20b",
      promptVersion: "solve-independent.id@1",
      usage: { inputTokens: 300, outputTokens: 120 },
      latencyMs: 900,
      outcome: "ok",
      createdAt: NOW,
    });
    const [row] = await database.db.select().from(aiCalls);
    expect(row).toMatchObject({ task: "solve_independent", model: "openai/gpt-oss-20b" });
  });

  it("counts only this job's provider_rate_limited rows for the owner", async () => {
    const c = await seedCurriculum(database.db);
    const mine = await seedGenerationRequest(database.db, { ownerId: USER_A, ...c });
    const row = (errorCode: string, jobId: string) =>
      insertAiCall(db(), {
        ownerId: USER_A,
        jobId,
        provider: "groq",
        model: "openai/gpt-oss-120b",
        promptVersion: "generate-mc.id@1",
        usage: { inputTokens: 0, outputTokens: 0 },
        latencyMs: 10,
        outcome: "error",
        errorCode,
        createdAt: NOW,
      });
    await row("provider_rate_limited", mine.jobId);
    await row("provider_rate_limited", mine.jobId);
    await row("provider_error", mine.jobId);

    expect(
      await countProviderDeferrals(db(), { ownerId: USER_A, jobId: mine.jobId }),
    ).toBe(2);
    expect(
      await countProviderDeferrals(db(), { ownerId: USER_B, jobId: mine.jobId }),
    ).toBe(0);
  });
});

describe("persistDrafts", () => {
  const drafts = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      multipleChoiceQuestionSchema.parse(questionJson(i + 1)),
    );

  const input = async (n: number) => {
    const c = await seedCurriculum(database.db);
    const { requestId } = await seedGenerationRequest(database.db, {
      ownerId: USER_A,
      ...c,
    });
    return {
      c,
      requestId,
      args: {
        ownerId: USER_A,
        requestId,
        topicId: c.topicId,
        sourceRef: c.sourceRef,
        grade: 8 as const,
        difficulty: "sulit" as const,
        run: {
          provider: "groq",
          model: "openai/gpt-oss-120b",
          promptVersion: "generate-mc.id@1",
          curriculumVersionId: c.versionId,
          usage: { inputTokens: 100, outputTokens: 50 },
          latencyMs: 1500,
        },
        questions: drafts(n),
        now: NOW,
      },
    };
  };

  it("writes the run, the questions, versions and sources, linked and owned", async () => {
    const { args, requestId, c } = await input(2);
    const result = await database.db.transaction(async (tx) =>
      persistDrafts(tx as unknown as AnyDb, args),
    );

    expect(result.questionIds).toHaveLength(2);
    const qs = await database.db.select().from(questions);
    expect(qs).toHaveLength(2);
    for (const q of qs) {
      expect(q).toMatchObject({
        ownerId: USER_A,
        status: "draft",
        origin: "generated",
        grade: 8,
        type: "multiple_choice",
        difficulty: "sulit",
        topicId: c.topicId,
        generationRequestId: requestId,
      });
      expect(q.currentVersionId).not.toBeNull();
    }

    const versions = await database.db.select().from(questionVersions);
    expect(versions).toHaveLength(2);
    for (const v of versions) {
      expect(v).toMatchObject({
        ownerId: USER_A,
        versionNo: 1,
        author: "ai",
        changeKind: "generated",
        verificationStatus: "belum_dapat_diverifikasi",
        generationRunId: result.runId,
      });
    }
    expect(versions.find((v) => v.stemMd === "Hitung $1 + 1$.")?.answer).toEqual({
      display_md: "2",
      machine: "2",
      correctLabel: "B",
    });
    expect(qs.map((q) => q.currentVersionId).sort()).toEqual(
      versions.map((v) => v.id).sort(),
    );

    const sources = await database.db.select().from(questionSources);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({
      ownerId: USER_A,
      kind: "curriculum",
      topicId: c.topicId,
      anchorLabel: c.sourceRef,
    });

    const [run] = await database.db.select().from(generationRuns);
    expect(run).toMatchObject({
      ownerId: USER_A,
      requestId,
      task: "generate_questions",
      provider: "groq",
      model: "openai/gpt-oss-120b",
      promptVersion: "generate-mc.id@1",
      curriculumVersionId: c.versionId,
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 1500,
      outcome: "ok",
    });
    expect(await database.db.select().from(verificationRuns)).toHaveLength(0);
    expect(await countDrafts(db(), { requestId, ownerId: USER_A })).toBe(2);
    expect(await countDrafts(db(), { requestId, ownerId: USER_B })).toBe(0);
  });

  it("stores the search text of each first version, with the topic's TP codes", async () => {
    const { args } = await input(2);
    await database.db.transaction(async (tx) =>
      persistDrafts(tx as unknown as AnyDb, args),
    );
    const qs = await database.db.select().from(questions);
    expect(qs).toHaveLength(2);
    const texts = qs.map((q) => q.searchText).sort();
    expect(texts[0]).toMatch(/^hitung 1 \+ 1 [.] /);
    expect(texts[0]).toMatch(/ tp-3$/);
    expect(texts[1]).toMatch(/^hitung 2 \+ 2 [.] /);
  });

  it("leaves nothing behind when a write fails", async () => {
    const { args } = await input(2);
    const bad = { ...args, topicId: "99999999-9999-4999-8999-999999999999" };
    await expect(
      database.db.transaction(async (tx) => persistDrafts(tx as unknown as AnyDb, bad)),
    ).rejects.toThrow();
    expect(await database.db.select().from(questions)).toHaveLength(0);
    expect(await database.db.select().from(questionVersions)).toHaveLength(0);
    expect(await database.db.select().from(generationRuns)).toHaveLength(0);
  });
});
