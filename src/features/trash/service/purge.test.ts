import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { logger } from "@/lib/logger";
import {
  insertVerificationRun,
  multipleChoiceQuestionSchema,
  persistDrafts,
  persistRegeneratedVersion,
  questionJson,
  seedCurriculum,
  seedGenerationRequest,
  type AnyDb,
} from "@/features/generation";
import {
  jakartaDayKey,
  purgeExpired,
  purgeQuestion,
  purgeTrashOncePerDay,
} from "./purge";
import { deletePermanently, restoreQuestion, trashQuestion } from "./trash";

let database: TestDatabase;
const NOW = new Date("2026-11-08T10:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const db = () => database.db as unknown as AnyDb;
let curriculum: Awaited<ReturnType<typeof seedCurriculum>> | undefined;

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  curriculum = undefined;
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

// `count` questions of `ownerId`, each with two versions (generated + regenerated), one run each.
async function seed(ownerId: string, count: number) {
  curriculum ??= await seedCurriculum(database.db);
  const c = curriculum;
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
      run: { ...RUN, curriculumVersionId: c.versionId },
      questions: Array.from({ length: count }, (_, i) =>
        multipleChoiceQuestionSchema.parse(questionJson(i + 1)),
      ),
      now: NOW,
    }),
  );
  for (const questionId of saved.questionIds) {
    const { versionId } = await database.db.transaction(async (tx) =>
      persistRegeneratedVersion(tx as unknown as AnyDb, {
        difficulty: "sedang",
        ownerId,
        requestId,
        questionId,
        topicId: c.topicId,
        sourceRef: c.sourceRef,
        run: { ...RUN, curriculumVersionId: c.versionId },
        question: multipleChoiceQuestionSchema.parse(questionJson(9)),
        now: NOW,
      }),
    );
    await insertVerificationRun(db(), {
      ownerId,
      versionId,
      verifierVersion: "v1",
      status: "terverifikasi",
      checks: [],
      crossCheck: { verdict: "agree" },
      now: NOW,
    });
  }
  return saved.questionIds;
}

// Makes the deletion_log insert of one question fail (a check even the superuser cannot bypass).
const blockLogOf = (questionId: string) =>
  database.db.execute(
    `alter table deletion_log add constraint deletion_log_test_block check (entity_id <> '${questionId}') not valid`,
  );
const unblockLog = () =>
  database.db.execute(`alter table deletion_log drop constraint deletion_log_test_block`);

const trashAt = (ownerId: string, questionId: string, at: Date) =>
  trashQuestion(db(), { ownerId, questionId, now: at });
const exists = async (questionId: string) =>
  (await database.db.select().from(questions).where(eq(questions.id, questionId)))
    .length > 0;
const versionCount = async (questionId: string) =>
  (
    await database.db
      .select()
      .from(questionVersions)
      .where(eq(questionVersions.questionId, questionId))
  ).length;

describe("purgeExpired", () => {
  it(
    "purge at day 30 removes expired rows only (simulated clock) and running it twice purges nothing more",
    async () => {
      const [oldA, youngA, liveA] = await seed(USER_A, 3);
      const [oldB] = await seed(USER_B, 1);
      await trashAt(USER_A, oldA, NOW);
      await trashAt(USER_B, oldB, NOW);
      await trashAt(USER_A, youngA, new Date(NOW.getTime() + DAY_MS));

      // Day 29: nothing is due yet.
      const day29 = new Date(NOW.getTime() + 29 * DAY_MS);
      expect(await purgeExpired(db(), day29)).toEqual({ purged: 0, failed: 0 });

      const day30 = new Date(NOW.getTime() + 30 * DAY_MS);
      expect(await purgeExpired(db(), day30)).toEqual({ purged: 2, failed: 0 });
      expect(await exists(oldA)).toBe(false);
      expect(await exists(oldB)).toBe(false);
      expect(await versionCount(oldA)).toBe(0);
      expect(await exists(youngA)).toBe(true);
      expect(await versionCount(youngA)).toBe(2);
      expect(await exists(liveA)).toBe(true);

      expect(await purgeExpired(db(), day30)).toEqual({ purged: 0, failed: 0 });

      const log = await database.db.select().from(deletionLog);
      expect(
        log
          .map((row) => ({ ownerId: row.ownerId, entityId: row.entityId }))
          .sort((a, b) => (a.entityId < b.entityId ? -1 : 1)),
      ).toEqual(
        [
          { ownerId: USER_A, entityId: oldA },
          { ownerId: USER_B, entityId: oldB },
        ].sort((a, b) => (a.entityId < b.entityId ? -1 : 1)),
      );
      // Ids and counts only: no content of the question.
      for (const row of log) {
        expect(row.entity).toBe("question");
        expect(row.counts).toEqual({
          questions: 1,
          versions: 2,
          verificationRuns: 1,
          sources: 2,
        });
      }
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "never touches a question that was restored before the purge got to it",
    async () => {
      const [questionId] = await seed(USER_A, 1);
      await trashAt(USER_A, questionId, NOW);
      await restoreQuestion(db(), { ownerId: USER_A, questionId });

      const day31 = new Date(NOW.getTime() + 31 * DAY_MS);
      expect(await purgeExpired(db(), day31)).toEqual({ purged: 0, failed: 0 });
      // The guard is re-checked under the row lock, so a candidate that was restored after it
      // was selected is skipped too.
      expect(
        await purgeQuestion(db(), { questionId, expiredBy: day31, now: day31 }),
      ).toBe(null);
      expect(await exists(questionId)).toBe(true);
      expect(await versionCount(questionId)).toBe(2);
      expect(await database.db.select().from(deletionLog)).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a row that fails is left intact and does not stop another owner's expired row",
    async () => {
      const [failing] = await seed(USER_A, 1);
      const [other] = await seed(USER_B, 1);
      await trashAt(USER_A, failing, NOW);
      await trashAt(USER_B, other, NOW);
      const runsBefore = (
        await database.db
          .select()
          .from(verificationRuns)
          .where(eq(verificationRuns.ownerId, USER_A))
      ).length;
      // The log insert of this one question fails (a check the superuser cannot bypass).
      await blockLogOf(failing);
      const logged = vi.spyOn(logger, "error").mockImplementation(() => undefined);
      try {
        expect(await purgeExpired(db(), new Date(NOW.getTime() + 30 * DAY_MS))).toEqual({
          purged: 1,
          failed: 1,
        });
      } finally {
        await unblockLog();
      }
      // The id, the error name and the Postgres code; never the query or its parameters.
      expect(logged.mock.calls).toEqual([
        [
          {
            module: "trash",
            questionId: failing,
            err: { name: "DrizzleQueryError", code: "23514" },
          },
          "trash: could not purge a question",
        ],
      ]);
      logged.mockRestore();
      expect(await exists(failing)).toBe(true);
      expect(await versionCount(failing)).toBe(2);
      expect(
        (
          await database.db
            .select()
            .from(verificationRuns)
            .where(eq(verificationRuns.ownerId, USER_A))
        ).length,
      ).toBe(runsBefore);
      expect(await exists(other)).toBe(false);
      expect(
        (await database.db.select().from(deletionLog)).map((r) => r.entityId),
      ).toEqual([other]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a question purged or deleted for good cannot be restored any more",
    async () => {
      const [purged, deleted] = await seed(USER_A, 2);
      await trashAt(USER_A, purged, NOW);
      await trashAt(USER_A, deleted, new Date(NOW.getTime() + 5 * DAY_MS));
      await purgeExpired(db(), new Date(NOW.getTime() + 30 * DAY_MS));
      await deletePermanently(db(), { ownerId: USER_A, questionId: deleted, now: NOW });
      for (const questionId of [purged, deleted]) {
        expect(await restoreQuestion(db(), { ownerId: USER_A, questionId })).toEqual({
          ok: false,
          error: "notFound",
        });
      }
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "delete permanently cancels a regeneration that has not started",
    async () => {
      const [questionId] = await seed(USER_A, 1);
      await trashAt(USER_A, questionId, NOW);
      // A job queued after the trash (a row written before the trash committed, say).
      const [job] = await database.db
        .insert(jobs)
        .values({
          ownerId: USER_A,
          type: "regenerate_question",
          payload: { questionId, hint: null },
          status: "deferred",
        })
        .returning({ id: jobs.id });
      await deletePermanently(db(), { ownerId: USER_A, questionId, now: NOW });
      const [row] = await database.db.select().from(jobs).where(eq(jobs.id, job.id));
      expect(row.status).toBe("cancelled");
    },
    DB_TEST_TIMEOUT,
  );
});

describe("purgeTrashOncePerDay", () => {
  it(
    "runs at most once per Asia/Jakarta day and records the day with the count only",
    async () => {
      const [first, second] = await seed(USER_A, 2);
      await trashAt(USER_A, first, NOW);
      // 2026-12-08 17:30 UTC is already 9 December in Jakarta.
      const tick = new Date("2026-12-08T17:30:00.000Z");
      expect(jakartaDayKey(tick)).toBe("2026-12-09");

      expect(await purgeTrashOncePerDay(db(), tick)).toEqual({ purged: 1, failed: 0 });
      // Expired since, but today's purge already ran: the next runs of the day do nothing.
      await trashAt(USER_A, second, new Date(NOW.getTime() - DAY_MS));
      await database.db
        .update(questions)
        .set({ purgeAfter: NOW })
        .where(eq(questions.id, second));
      expect(
        await purgeTrashOncePerDay(db(), new Date("2026-12-09T16:59:00.000Z")),
      ).toBeNull();
      expect(await exists(second)).toBe(true);

      // Jakarta midnight: a new day, a new run.
      expect(
        await purgeTrashOncePerDay(db(), new Date("2026-12-09T17:00:00.000Z")),
      ).toEqual({ purged: 1, failed: 0 });
      expect(await exists(second)).toBe(false);

      const marks = await database.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "trash_purged"));
      expect(marks.map((row) => [row.ownerId, row.metadata])).toEqual([
        [null, { day: "2026-12-09", purged: 1, failed: 0 }],
        [null, { day: "2026-12-10", purged: 1, failed: 0 }],
      ]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "writes the day's marker even when a row fails, and the row is retried the next day",
    async () => {
      const [questionId] = await seed(USER_A, 1);
      await trashAt(USER_A, questionId, NOW);
      const tick = new Date(NOW.getTime() + 30 * DAY_MS);
      await blockLogOf(questionId);
      const logged = vi.spyOn(logger, "error").mockImplementation(() => undefined);
      try {
        expect(await purgeTrashOncePerDay(db(), tick)).toEqual({ purged: 0, failed: 1 });
      } finally {
        await unblockLog();
      }
      expect(logged).toHaveBeenCalledTimes(1);
      logged.mockRestore();
      expect(await purgeTrashOncePerDay(db(), tick)).toBeNull();
      expect(await exists(questionId)).toBe(true);
      expect(await purgeTrashOncePerDay(db(), new Date(tick.getTime() + DAY_MS))).toEqual(
        { purged: 1, failed: 0 },
      );
      expect(await exists(questionId)).toBe(false);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "releases today's claim when the time is already up after claiming, so the next run purges",
    async () => {
      const [questionId] = await seed(USER_A, 1);
      await trashAt(USER_A, questionId, NOW);
      const tick = new Date(NOW.getTime() + 30 * DAY_MS);
      // The claim itself took 6 s of a 5 s budget (a slow database).
      const reads = [0, 6_000];
      const clock = () => reads.shift() ?? 6_000;
      const onBacklog = vi.fn();
      expect(
        await purgeTrashOncePerDay(db(), tick, undefined, {
          budgetMs: 5_000,
          clock,
          onBacklog,
        }),
      ).toEqual({ purged: 0, failed: 0 });
      expect(onBacklog).toHaveBeenCalledTimes(1);
      expect(await exists(questionId)).toBe(true);
      expect(
        await database.db
          .select()
          .from(auditLog)
          .where(eq(auditLog.action, "trash_purged")),
      ).toEqual([]);
      // The next run of the same day still has the day and purges.
      expect(await purgeTrashOncePerDay(db(), tick)).toEqual({ purged: 1, failed: 0 });
      expect(await exists(questionId)).toBe(false);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "floors a tiny budget so a claimed day always attempts a row",
    async () => {
      const [questionId] = await seed(USER_A, 1);
      await trashAt(USER_A, questionId, NOW);
      const tick = new Date(NOW.getTime() + 30 * DAY_MS);
      let now = 0;
      const clock = () => (now += 100);
      expect(
        await purgeTrashOncePerDay(db(), tick, undefined, { budgetMs: 1, clock }),
      ).toEqual({
        purged: 1,
        failed: 0,
      });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "only an ownerless marker counts as today's run",
    async () => {
      const [questionId] = await seed(USER_A, 1);
      await trashAt(USER_A, questionId, NOW);
      const tick = new Date(NOW.getTime() + 30 * DAY_MS);
      await database.db.insert(auditLog).values({
        ownerId: USER_A,
        action: "trash_purged",
        metadata: { day: jakartaDayKey(tick) },
      });
      expect(await purgeTrashOncePerDay(db(), tick)).toEqual({ purged: 1, failed: 0 });
    },
    DB_TEST_TIMEOUT,
  );
});
