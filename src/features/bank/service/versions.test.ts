import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
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
import { createFakeProvider, createGateway, defaultRouting } from "@/lib/ai";
import {
  buildContext,
  solverPicking,
  createRegenerateQuestionHandler,
  requestRegeneration,
  insertVerificationRun,
  multipleChoiceQuestionSchema,
  persistDrafts,
  persistRegeneratedVersion,
  questionJson,
  seedCurriculum,
  seedGenerationRequest,
  type AnyDb,
} from "@/features/generation";
import { bankQuerySchema } from "../schema/bank-query";
import { getBankList } from "./bank";
import {
  getVersionHistory,
  getVersionQuestion,
  listVersions,
  restoreVersion,
} from "./versions";

let database: TestDatabase;
const NOW = new Date("2026-11-08T10:00:00.000Z");
const LATER = new Date("2026-11-08T11:00:00.000Z");
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

const RUN = {
  provider: "groq",
  model: "openai/gpt-oss-120b",
  promptVersion: "generate-mc.id@2",
  usage: { inputTokens: 1, outputTokens: 1 },
  latencyMs: 5,
};

// v1 "Hitung $1 + 1$." (verified, cross-check agreed) and v2 "Hitung $2 + 2$." (regenerated, with
// the given status).
async function seed(v2Status: "terverifikasi" | "ketidaksesuaian" = "terverifikasi") {
  const c = await seedCurriculum(database.db);
  const { requestId, jobId } = await seedGenerationRequest(database.db, {
    ownerId: USER_A,
    quantity: 1,
    ...c,
  });
  const saved = await database.db.transaction(async (tx) =>
    persistDrafts(tx as unknown as AnyDb, {
      ownerId: USER_A,
      requestId,
      topicId: c.topicId,
      sourceRef: c.sourceRef,
      grade: 8,
      difficulty: "sedang",
      run: { ...RUN, curriculumVersionId: c.versionId },
      questions: [multipleChoiceQuestionSchema.parse(questionJson(1))],
      now: NOW,
    }),
  );
  const questionId = saved.questionIds[0];
  const v1 = (await loadQuestion(questionId)).currentVersionId ?? "";
  await insertVerificationRun(db(), {
    ownerId: USER_A,
    versionId: v1,
    verifierVersion: "v1",
    status: "terverifikasi",
    checks: [{ type: "numeric_eval", status: "pass", detail: "1+1 = 2" }],
    crossCheck: { verdict: "agree" },
    now: NOW,
  });
  const { versionId: v2 } = await database.db.transaction(async (tx) =>
    persistRegeneratedVersion(tx as unknown as AnyDb, {
      difficulty: "sedang",
      ownerId: USER_A,
      requestId,
      questionId,
      topicId: c.topicId,
      sourceRef: c.sourceRef,
      run: { ...RUN, curriculumVersionId: c.versionId },
      question: multipleChoiceQuestionSchema.parse(questionJson(2)),
      now: NOW,
    }),
  );
  await insertVerificationRun(db(), {
    ownerId: USER_A,
    versionId: v2,
    verifierVersion: "v1",
    status: v2Status,
    checks: [],
    crossCheck: { verdict: v2Status === "terverifikasi" ? "agree" : "disagree" },
    now: NOW,
  });
  await database.db.update(jobs).set({ status: "succeeded" }).where(eq(jobs.id, jobId));
  return { questionId, v1, v2 };
}

const loadQuestion = async (questionId: string) =>
  (await database.db.select().from(questions).where(eq(questions.id, questionId)))[0];
const versionsOf = (questionId: string) =>
  database.db
    .select()
    .from(questionVersions)
    .where(eq(questionVersions.questionId, questionId))
    .orderBy(asc(questionVersions.versionNo));

async function restore(
  questionId: string,
  versionId: string,
  overrides: Partial<Parameters<typeof restoreVersion>[1]> = {},
) {
  const q = await loadQuestion(questionId);
  return restoreVersion(db(), {
    ownerId: USER_A,
    questionId,
    versionId,
    expectedRowVersion: q.rowVersion,
    now: LATER,
    ...overrides,
  });
}

async function approve(questionId: string) {
  const q = await loadQuestion(questionId);
  await database.db
    .update(questions)
    .set({
      status: "approved",
      approvedVersionId: q.currentVersionId,
      approvedAt: NOW,
      bankedAt: NOW,
    })
    .where(eq(questions.id, questionId));
}

describe("restoreVersion", () => {
  it(
    "restore previous creates n+2 copying n and keeps every old version",
    async () => {
      const { questionId, v1 } = await seed();
      const before = await versionsOf(questionId);
      const q = await loadQuestion(questionId);

      const result = await restore(questionId, v1);

      expect(result.ok).toBe(true);
      const after = await versionsOf(questionId);
      expect(after.map((v) => v.versionNo)).toEqual([1, 2, 3]);
      expect(after.slice(0, 2)).toEqual(before);
      const [old, , restored] = after;
      expect(restored).toMatchObject({
        author: "teacher",
        changeKind: "restored",
        stemMd: old.stemMd,
        options: old.options,
        answer: old.answer,
        explanationMd: old.explanationMd,
        steps: old.steps,
        verificationClaims: old.verificationClaims,
      });
      if (result.ok) expect(result.data.versionId).toBe(restored.id);

      const now = await loadQuestion(questionId);
      expect(now.currentVersionId).toBe(restored.id);
      expect(now.rowVersion).toBe(q.rowVersion + 1);
      expect(now.searchText).toContain("1 + 1");
      // The copied version carries the verification it had, and its curriculum anchor.
      const runs = await database.db
        .select()
        .from(verificationRuns)
        .where(eq(verificationRuns.questionVersionId, restored.id));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        status: "terverifikasi",
        crossCheck: { verdict: "agree" },
      });
      const sources = await database.db
        .select()
        .from(questionSources)
        .where(eq(questionSources.questionVersionId, restored.id));
      expect(sources).toHaveLength(1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "stale restore is refused and writes nothing",
    async () => {
      const { questionId, v1 } = await seed();
      const q = await loadQuestion(questionId);
      expect(
        await restore(questionId, v1, { expectedRowVersion: q.rowVersion - 1 }),
      ).toEqual({ ok: false, error: "stale" });
      expect(await versionsOf(questionId)).toHaveLength(2);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "restoring a mismatch version keeps mismatch and takes a banked question back to review",
    async () => {
      const { questionId, v1, v2 } = await seed("ketidaksesuaian");
      await restore(questionId, v1);
      await approve(questionId);
      // Restore the contradicted version over the approved, banked one.
      const result = await restore(questionId, v2);
      expect(result.ok).toBe(true);
      const q = await loadQuestion(questionId);
      const runs = await database.db
        .select()
        .from(verificationRuns)
        .where(eq(verificationRuns.questionVersionId, q.currentVersionId ?? ""));
      expect(runs[0].status).toBe("ketidaksesuaian");
      expect(q).toMatchObject({
        status: "draft",
        approvedVersionId: null,
        bankedAt: null,
      });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a banked question restored to a sound version stays banked on it",
    async () => {
      const { questionId, v1 } = await seed();
      await approve(questionId);
      await restore(questionId, v1);
      const q = await loadQuestion(questionId);
      expect(q.status).toBe("approved");
      expect(q.bankedAt).not.toBeNull();
      expect(q.approvedVersionId).toBe(q.currentVersionId);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses a trashed question, another teacher's question and a version of another question",
    async () => {
      const { questionId, v1 } = await seed();
      expect(await restore(questionId, v1, { ownerId: USER_B })).toEqual({
        ok: false,
        error: "notFound",
      });
      expect(await restore(questionId, "00000000-0000-4000-8000-000000000000")).toEqual({
        ok: false,
        error: "notFound",
      });
      await database.db
        .update(questions)
        .set({ deletedAt: NOW, purgeAfter: LATER })
        .where(eq(questions.id, questionId));
      expect(await restore(questionId, v1)).toEqual({ ok: false, error: "trashed" });
      expect(await versionsOf(questionId)).toHaveLength(2);
    },
    DB_TEST_TIMEOUT,
  );
  it(
    "regenerate easier then restore the previous version returns its difficulty and the bank filters follow",
    async () => {
      const { questionId, v2 } = await seed();
      // v2 is the current version and banked.
      await approve(questionId);
      const queued = await requestRegeneration(db(), {
        ownerId: USER_A,
        questionId,
        hint: "easier",
        now: LATER,
      });
      if (!queued.ok) throw new Error("refused");
      const provider = createFakeProvider("groq", [
        JSON.stringify({ questions: [questionJson(7)] }),
        solverPicking("B", "14"),
      ]);
      await createRegenerateQuestionHandler({
        db: db(),
        createGateway: (budget) =>
          createGateway({
            routing: defaultRouting,
            providers: { groq: provider },
            budget,
          }),
        now: () => LATER,
      })(await buildContext(database.db, queued.data.jobId, { now: LATER }));
      await database.db
        .update(jobs)
        .set({ status: "succeeded" })
        .where(eq(jobs.id, queued.data.jobId));

      const versions = await versionsOf(questionId);
      expect(versions.map((v) => v.difficulty)).toEqual(["sedang", "sedang", "mudah"]);
      expect((await loadQuestion(questionId)).difficulty).toBe("mudah");
      const inBank = async (difficulty: "mudah" | "sedang") =>
        (
          await getBankList(db(), {
            ownerId: USER_A,
            query: bankQuerySchema.parse({ difficulty }),
          })
        ).items.map((item) => item.questionId);
      expect(await inBank("mudah")).toEqual([questionId]);

      const restored = await restore(questionId, v2);
      expect(restored.ok).toBe(true);
      expect((await loadQuestion(questionId)).difficulty).toBe("sedang");
      expect((await versionsOf(questionId)).at(-1)?.difficulty).toBe("sedang");
      expect(await inBank("sedang")).toEqual([questionId]);
      expect(await inBank("mudah")).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );
  it(
    "refuses while a regeneration of the question is pending, and refuses the current version",
    async () => {
      const { questionId, v1, v2 } = await seed();
      expect(await restore(questionId, v2)).toEqual({ ok: false, error: "current" });
      await database.db.insert(jobs).values({
        ownerId: USER_A,
        type: "regenerate_question",
        payload: { questionId, hint: null },
        status: "deferred",
      });
      expect(await restore(questionId, v1)).toEqual({ ok: false, error: "notReady" });
      expect(await versionsOf(questionId)).toHaveLength(2);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("getVersionQuestion guards", () => {
  it(
    "refuses a version of another question of the same owner, and a trashed question",
    async () => {
      const first = await seed();
      const second = await seed();
      const own = { ownerId: USER_A, questionId: first.questionId };
      expect(await getVersionQuestion(db(), { ...own, versionId: second.v1 })).toBeNull();
      expect(
        (await getVersionQuestion(db(), { ...own, versionId: first.v1 }))?.versionNo,
      ).toBe(1);
      await database.db
        .update(questions)
        .set({ deletedAt: NOW })
        .where(eq(questions.id, first.questionId));
      expect(await getVersionQuestion(db(), { ...own, versionId: first.v1 })).toBeNull();
    },
    DB_TEST_TIMEOUT,
  );
});

describe("listVersions", () => {
  it(
    "history lists versions newest first with author, kind, date and status",
    async () => {
      const { questionId, v1, v2 } = await seed("ketidaksesuaian");
      await restore(questionId, v1);

      const list = await listVersions(db(), { ownerId: USER_A, questionId });

      expect(list.map((v) => v.versionNo)).toEqual([3, 2, 1]);
      expect(list.map((v) => v.changeKind)).toEqual([
        "restored",
        "regenerated",
        "generated",
      ]);
      expect(list.map((v) => v.author)).toEqual(["teacher", "ai", "ai"]);
      // v3 is a copy of v1 and carries its verification; v2 was contradicted.
      expect(list.map((v) => v.status)).toEqual([
        "terverifikasi",
        "ketidaksesuaian",
        "terverifikasi",
      ]);
      expect(list.map((v) => v.isCurrent)).toEqual([true, false, false]);
      expect(list[1].id).toBe(v2);
      expect(list[0].createdAt).toBe(LATER.toISOString());
      expect(list[2].createdAt).toBe(NOW.toISOString());
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "is empty for a trashed question and for another teacher's question",
    async () => {
      const { questionId } = await seed();
      expect(await listVersions(db(), { ownerId: USER_B, questionId })).toEqual([]);
      expect(await getVersionHistory(db(), { ownerId: USER_B, questionId })).toBeNull();
      await database.db
        .update(questions)
        .set({ deletedAt: NOW })
        .where(eq(questions.id, questionId));
      expect(await listVersions(db(), { ownerId: USER_A, questionId })).toEqual([]);
      expect(await getVersionHistory(db(), { ownerId: USER_A, questionId })).toBeNull();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "opens any version read-only and refuses a version of another question or owner",
    async () => {
      const { questionId, v1 } = await seed();
      const view = await getVersionQuestion(db(), {
        ownerId: USER_A,
        questionId,
        versionId: v1,
      });
      expect(view?.versionNo).toBe(1);
      expect(view?.stemMd).toContain("1 + 1");
      expect(
        await getVersionQuestion(db(), { ownerId: USER_B, questionId, versionId: v1 }),
      ).toBeNull();
      const history = await getVersionHistory(db(), { ownerId: USER_A, questionId });
      expect(history?.rowVersion).toBe((await loadQuestion(questionId)).rowVersion);
      expect(history?.versions).toHaveLength(2);
    },
    DB_TEST_TIMEOUT,
  );
  it(
    "restoring while the approval waits on an older version leaves it banked and visible (R19)",
    async () => {
      const { questionId, v1, v2 } = await seed();
      // Approved and banked on v1; v2 is a regeneration whose job is gone (stranded).
      await database.db
        .update(questions)
        .set({
          status: "approved",
          approvedVersionId: v1,
          approvedAt: NOW,
          bankedAt: NOW,
        })
        .where(eq(questions.id, questionId));
      expect((await loadQuestion(questionId)).currentVersionId).toBe(v2);

      expect((await restore(questionId, v1)).ok).toBe(true);
      const q = await loadQuestion(questionId);
      expect(q.status).toBe("approved");
      expect(q.bankedAt).not.toBeNull();
      expect(q.approvedVersionId).toBe(q.currentVersionId);
      const listed = await getBankList(db(), {
        ownerId: USER_A,
        query: bankQuerySchema.parse({}),
      });
      expect(listed.items.map((item) => item.questionId)).toEqual([questionId]);
    },
    DB_TEST_TIMEOUT,
  );
});
