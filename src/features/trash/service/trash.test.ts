import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  aiCalls,
  auditLog,
  cpElements,
  curriculumVersions,
  deletionLog,
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
  getQuestionTrace,
  insertVerificationRun,
  multipleChoiceQuestionSchema,
  persistDrafts,
  persistRegeneratedVersion,
  questionJson,
  seedCurriculum,
  seedGenerationRequest,
  type AnyDb,
} from "@/features/generation";
import { getDashboard } from "@/features/beranda";
import { decideQuestion, getRequestReview } from "@/features/review";
import { bankApprovedQuestions, bankQuerySchema, getBankList } from "@/features/bank";
import { deletePermanently, listTrash, restoreQuestion, trashQuestion } from "./trash";

let database: TestDatabase;
const NOW = new Date("2026-11-08T10:00:00.000Z");
const LATER = new Date("2026-11-10T10:00:00.000Z");
const db = () => database.db as unknown as AnyDb;

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  const d = database.db;
  await d.delete(deletionLog);
  await d.delete(auditLog);
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

// Three questions of one finished request: [0] banked, [1] approved not banked, [2] draft.
async function seed(ownerId = USER_A) {
  const c = await seedCurriculum(database.db);
  const { requestId, jobId } = await seedGenerationRequest(database.db, {
    ownerId,
    quantity: 3,
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
      run: { ...RUN, curriculumVersionId: c.versionId },
      questions: [1, 2, 3].map((n) =>
        multipleChoiceQuestionSchema.parse(questionJson(n)),
      ),
      now: NOW,
    }),
  );
  for (const questionId of saved.questionIds) {
    const q = await loadQuestion(questionId);
    await insertVerificationRun(db(), {
      ownerId,
      versionId: q.currentVersionId ?? "",
      verifierVersion: "v1",
      status: "terverifikasi",
      checks: [],
      crossCheck: { verdict: "agree" },
      now: NOW,
    });
  }
  await database.db.update(jobs).set({ status: "succeeded" }).where(eq(jobs.id, jobId));
  const [banked, approved, draft] = saved.questionIds;
  for (const [questionId, bankedAt] of [
    [banked, NOW],
    [approved, null],
  ] as const) {
    const q = await loadQuestion(questionId);
    await database.db
      .update(questions)
      .set({
        status: "approved",
        approvedVersionId: q.currentVersionId,
        approvedAt: NOW,
        bankedAt,
      })
      .where(eq(questions.id, questionId));
  }
  return { requestId, banked, approved, draft };
}

const loadQuestion = async (questionId: string) =>
  (await database.db.select().from(questions).where(eq(questions.id, questionId)))[0];

const bankIds = async (ownerId = USER_A) =>
  (await getBankList(db(), { ownerId, query: bankQuerySchema.parse({}) })).items.map(
    (item) => item.questionId,
  );

async function regenerateJob(questionId: string, status: string, ownerId = USER_A) {
  const [job] = await database.db
    .insert(jobs)
    .values({
      ownerId,
      type: "regenerate_question",
      payload: { questionId, hint: null },
      status,
    })
    .returning({ id: jobs.id });
  return job.id;
}
const jobStatus = async (id: string) =>
  (await database.db.select().from(jobs).where(eq(jobs.id, id)))[0].status;

describe("trashQuestion", () => {
  it(
    "trashing during a regeneration that saved its version settles the approval (R19)",
    async () => {
      const { requestId, banked } = await seed();
      const c = await database.db
        .select()
        .from(questions)
        .where(eq(questions.id, banked));
      // The regeneration saved v2 and now waits (deferred) for its cross-check.
      await database.db.transaction(async (tx) =>
        persistRegeneratedVersion(tx as unknown as AnyDb, {
          ownerId: USER_A,
          requestId,
          questionId: banked,
          topicId: c[0].topicId,
          sourceRef: "ref-2",
          run: { ...RUN, curriculumVersionId: null as unknown as string },
          question: multipleChoiceQuestionSchema.parse(questionJson(9)),
          difficulty: "sedang",
          now: NOW,
          versionNo: 2,
        }),
      );
      const job = await regenerateJob(banked, "deferred");
      expect(await bankIds()).toContain(banked);

      await trashQuestion(db(), { ownerId: USER_A, questionId: banked, now: LATER });
      expect(await jobStatus(job)).toBe("cancelled");
      await restoreQuestion(db(), { ownerId: USER_A, questionId: banked });

      // Back in review, never approved-but-invisible.
      expect(await loadQuestion(banked)).toMatchObject({
        status: "draft",
        approvedVersionId: null,
        bankedAt: null,
      });
      expect(await bankIds()).not.toContain(banked);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "trash hides the question from bank, review lists and Home counts",
    async () => {
      const { requestId, banked, approved, draft } = await seed();
      const before = await getDashboard(db(), { ownerId: USER_A });
      expect(before.bankedCount).toBe(1);
      expect(before.undecidedTotal).toBe(1);
      expect(before.pending[0]).toMatchObject({ undecided: 1, readyToSave: 1 });

      for (const questionId of [banked, approved, draft]) {
        expect(
          await trashQuestion(db(), { ownerId: USER_A, questionId, now: LATER }),
        ).toEqual({ ok: true, data: undefined });
      }

      expect(await bankIds()).toEqual([]);
      const list = await getBankList(db(), {
        ownerId: USER_A,
        query: bankQuerySchema.parse({ q: "hitung" }),
      });
      expect(list.items).toEqual([]);
      expect(list.facets).toEqual({ grades: [], elements: [], topics: [] });
      const review = await getRequestReview(db(), { ownerId: USER_A, requestId });
      expect(review?.questions).toEqual([]);
      expect(await getQuestionTrace(db(), { ownerId: USER_A, questionId: draft })).toBe(
        null,
      );
      const after = await getDashboard(db(), { ownerId: USER_A });
      expect(after.bankedCount).toBe(0);
      expect(after.undecidedTotal).toBe(0);
      expect(after.pending).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "sets deleted_at and purge_after 30 days later and changes nothing else",
    async () => {
      const { banked } = await seed();
      const before = await loadQuestion(banked);
      await trashQuestion(db(), { ownerId: USER_A, questionId: banked, now: LATER });
      const after = await loadQuestion(banked);
      expect(after.deletedAt).toEqual(LATER);
      expect(after.purgeAfter).toEqual(new Date("2026-12-10T10:00:00.000Z"));
      expect({ ...after, deletedAt: null, purgeAfter: null }).toEqual(before);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a trashed question cannot be approved, banked or trashed again",
    async () => {
      const { requestId, approved, draft } = await seed();
      await trashQuestion(db(), { ownerId: USER_A, questionId: approved, now: LATER });
      await trashQuestion(db(), { ownerId: USER_A, questionId: draft, now: LATER });
      expect(
        await bankApprovedQuestions(db(), { ownerId: USER_A, requestId, now: LATER }),
      ).toEqual({ saved: 0 });
      const q = await loadQuestion(draft);
      expect(
        await decideQuestion(db(), {
          ownerId: USER_A,
          questionId: draft,
          versionId: q.currentVersionId ?? "",
          rowVersion: q.rowVersion,
          action: "approve",
          now: LATER,
        }),
      ).toEqual({ ok: false, error: "not_found" });
      expect(
        await trashQuestion(db(), { ownerId: USER_A, questionId: draft, now: LATER }),
      ).toEqual({ ok: false, error: "notFound" });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "cancels the question's regenerations that have not started and leaves others alone",
    async () => {
      const { banked, draft } = await seed();
      const queued = await regenerateJob(banked, "queued");
      const deferred = await regenerateJob(banked, "deferred");
      const running = await regenerateJob(banked, "running");
      const other = await regenerateJob(draft, "deferred");

      await trashQuestion(db(), { ownerId: USER_A, questionId: banked, now: LATER });

      expect(await jobStatus(queued)).toBe("cancelled");
      expect(await jobStatus(deferred)).toBe("cancelled");
      expect(await jobStatus(running)).toBe("running");
      expect(await jobStatus(other)).toBe("deferred");
    },
    DB_TEST_TIMEOUT,
  );
});

describe("restoreQuestion", () => {
  it(
    "restore brings it back unchanged",
    async () => {
      const { banked, approved } = await seed();
      const bankedBefore = await loadQuestion(banked);
      const approvedBefore = await loadQuestion(approved);
      for (const questionId of [banked, approved]) {
        await trashQuestion(db(), { ownerId: USER_A, questionId, now: LATER });
        expect(await restoreQuestion(db(), { ownerId: USER_A, questionId })).toEqual({
          ok: true,
          data: undefined,
        });
      }
      expect(await loadQuestion(banked)).toEqual(bankedBefore);
      expect(await loadQuestion(approved)).toEqual(approvedBefore);
      expect(await bankIds()).toEqual([banked]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses a question that is not in the trash",
    async () => {
      const { banked } = await seed();
      expect(
        await restoreQuestion(db(), { ownerId: USER_A, questionId: banked }),
      ).toEqual({ ok: false, error: "notInTrash" });
    },
    DB_TEST_TIMEOUT,
  );
});

describe("deletePermanently", () => {
  it(
    "delete permanently removes question, versions and verification runs and logs counts",
    async () => {
      const { banked, draft } = await seed();
      const versionId = (await loadQuestion(banked)).currentVersionId ?? "";
      await trashQuestion(db(), { ownerId: USER_A, questionId: banked, now: LATER });

      const result = await deletePermanently(db(), {
        ownerId: USER_A,
        questionId: banked,
        now: LATER,
      });

      expect(result).toEqual({
        ok: true,
        data: { versions: 1, verificationRuns: 1, sources: 1 },
      });
      expect(await loadQuestion(banked)).toBeUndefined();
      expect(
        await database.db
          .select()
          .from(questionVersions)
          .where(eq(questionVersions.questionId, banked)),
      ).toEqual([]);
      expect(
        await database.db
          .select()
          .from(verificationRuns)
          .where(eq(verificationRuns.questionVersionId, versionId)),
      ).toEqual([]);
      expect(
        await database.db
          .select()
          .from(questionSources)
          .where(eq(questionSources.questionVersionId, versionId)),
      ).toEqual([]);
      const log = await database.db.select().from(deletionLog);
      expect(log).toEqual([
        {
          id: expect.any(String) as string,
          ownerId: USER_A,
          entity: "question",
          entityId: banked,
          counts: { questions: 1, versions: 1, verificationRuns: 1, sources: 1 },
          deletedAt: LATER,
        },
      ]);
      // The other questions are untouched.
      expect(await loadQuestion(draft)).toBeDefined();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses a question that is not in the trash and writes nothing",
    async () => {
      const { banked } = await seed();
      expect(
        await deletePermanently(db(), {
          ownerId: USER_A,
          questionId: banked,
          now: LATER,
        }),
      ).toEqual({ ok: false, error: "notInTrash" });
      expect(await loadQuestion(banked)).toBeDefined();
      expect(await database.db.select().from(deletionLog)).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("another owner", () => {
  it(
    "another user cannot trash, restore or purge-delete my question",
    async () => {
      const { banked, draft } = await seed();
      const missing = { ok: false, error: "notFound" };

      expect(
        await trashQuestion(db(), { ownerId: USER_B, questionId: banked, now: LATER }),
      ).toEqual(missing);
      expect((await loadQuestion(banked)).deletedAt).toBeNull();

      await trashQuestion(db(), { ownerId: USER_A, questionId: draft, now: LATER });
      const job = await regenerateJob(draft, "queued", USER_A);
      expect(await restoreQuestion(db(), { ownerId: USER_B, questionId: draft })).toEqual(
        missing,
      );
      expect(
        await deletePermanently(db(), { ownerId: USER_B, questionId: draft, now: LATER }),
      ).toEqual(missing);
      expect((await loadQuestion(draft)).deletedAt).toEqual(LATER);
      expect(await jobStatus(job)).toBe("queued");
      expect(await listTrash(db(), { ownerId: USER_B, now: LATER })).toEqual([]);
      expect(await database.db.select().from(deletionLog)).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("listTrash", () => {
  it(
    "lists trashed questions newest first with the days left and version count",
    async () => {
      const { banked, draft } = await seed();
      await trashQuestion(db(), { ownerId: USER_A, questionId: banked, now: NOW });
      await trashQuestion(db(), { ownerId: USER_A, questionId: draft, now: LATER });

      const items = await listTrash(db(), {
        ownerId: USER_A,
        now: new Date("2026-11-10T12:00:00.000Z"),
      });

      expect(items.map((item) => item.questionId)).toEqual([draft, banked]);
      expect(items[0]).toMatchObject({
        topicTitle: expect.any(String) as string,
        versionCount: 1,
        deletedAt: LATER.toISOString(),
        purgeAfter: "2026-12-10T10:00:00.000Z",
        daysLeft: 30,
      });
      expect(items[0].stemExcerptMd.length).toBeGreaterThan(0);
      expect(items[1].daysLeft).toBe(28);
    },
    DB_TEST_TIMEOUT,
  );
});
