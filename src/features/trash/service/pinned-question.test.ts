// Ruling R2: a question pinned by an assessment item cannot go for good while the assessment exists.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deletionLog, questions } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { logger } from "@/lib/logger";
import type { AnyDb } from "@/features/generation";
import { getAssessmentEditor } from "@/features/assessments";
import { seedBankedQuestions } from "@/features/assessments/test-support";
import { seedCurriculum } from "@/features/generation";
import { asUser, seedApprovedAssessment } from "@/features/export/db-test-support";
import { clearTrashTables, listingStore } from "../db-test-support";
import { deleteAssessmentPermanently, trashAssessment } from "./assessment-trash";
import { purgeExpired } from "./purge";
import { deletePermanently, listTrash, trashQuestion } from "./trash";

let database: TestDatabase;
const db = () => database.db as unknown as AnyDb;
const NOW = new Date("2026-11-20T03:00:00.000Z");
const DAY30 = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  await clearTrashTables(database);
});

const exists = async (questionId: string) =>
  (await database.db.select().from(questions).where(eq(questions.id, questionId)))
    .length > 0;

describe("a trashed question pinned by an assessment", () => {
  it(
    "can be trashed, and the assessment's item is flagged",
    async () => {
      const s = await seedApprovedAssessment(database, { ownerId: USER_A });
      const [pinned] = s.questionIds;
      expect(
        await trashQuestion(db(), { ownerId: USER_A, questionId: pinned, now: NOW }),
      ).toEqual({
        ok: true,
        data: undefined,
      });
      const editor = await asUser(database, USER_A, (tx) =>
        getAssessmentEditor(tx, { ownerId: USER_A, assessmentId: s.assessmentId }),
      );
      const item = editor?.sections[0].items.find((entry) => entry.questionId === pinned);
      expect(item).toMatchObject({ state: "trashed" });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "is skipped by the purge (logged with ids and a count) while an unpinned one goes",
    async () => {
      const s = await seedApprovedAssessment(database, { ownerId: USER_A });
      const [pinned] = s.questionIds;
      const [loose] = await seedBankedQuestions(database, {
        ownerId: USER_A,
        count: 1,
        curriculum: await seedCurriculum(database.db),
      });
      await trashQuestion(db(), { ownerId: USER_A, questionId: pinned, now: NOW });
      await trashQuestion(db(), { ownerId: USER_A, questionId: loose, now: NOW });
      const infos = vi.spyOn(logger, "info").mockImplementation(() => undefined);
      expect(await purgeExpired(db(), DAY30)).toEqual({ purged: 1, failed: 0 });
      // Kept rows are counted once per run, ids and content left out.
      expect(infos.mock.calls).toEqual([
        [
          { module: "trash", blockedQuestions: 1 },
          "trash: expired questions pinned by an assessment are kept",
        ],
      ]);
      infos.mockRestore();
      expect(await exists(pinned)).toBe(true);
      expect(await exists(loose)).toBe(false);
      // Still skipped on the next run: nothing changes until the assessment is gone.
      vi.spyOn(logger, "info").mockImplementation(() => undefined);
      expect(await purgeExpired(db(), DAY30)).toEqual({ purged: 0, failed: 0 });
      vi.restoreAllMocks();
      expect(await exists(pinned)).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "never lets a full batch of pinned questions starve an expired free one behind them",
    async () => {
      const s = await seedApprovedAssessment(database, { ownerId: USER_A, count: 3 });
      const [loose] = await seedBankedQuestions(database, {
        ownerId: USER_A,
        count: 1,
        curriculum: await seedCurriculum(database.db),
      });
      // The pinned ones were trashed first, so they come first in purge order.
      for (const questionId of s.questionIds) {
        await trashQuestion(db(), {
          ownerId: USER_A,
          questionId,
          now: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
        });
      }
      await trashQuestion(db(), { ownerId: USER_A, questionId: loose, now: NOW });
      vi.spyOn(logger, "info").mockImplementation(() => undefined);
      try {
        expect(await purgeExpired(db(), DAY30, { batch: 2 })).toEqual({
          purged: 1,
          failed: 0,
        });
      } finally {
        vi.restoreAllMocks();
      }
      expect(await exists(loose)).toBe(false);
      for (const questionId of s.questionIds) expect(await exists(questionId)).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "is listed with the assessments that keep it, and a free one with none",
    async () => {
      const s = await seedApprovedAssessment(database, {
        ownerId: USER_A,
        title: "Ulangan Bab 1",
      });
      const [pinned] = s.questionIds;
      const [loose] = await seedBankedQuestions(database, {
        ownerId: USER_A,
        count: 1,
        curriculum: await seedCurriculum(database.db),
      });
      await trashQuestion(db(), { ownerId: USER_A, questionId: pinned, now: NOW });
      await trashQuestion(db(), { ownerId: USER_A, questionId: loose, now: NOW });
      const listed = await asUser(database, USER_A, (tx) =>
        listTrash(tx, { ownerId: USER_A, now: NOW }),
      );
      expect(
        Object.fromEntries(listed.map((item) => [item.questionId, item.pinnedBy])),
      ).toEqual({ [pinned]: ["Ulangan Bab 1"], [loose]: [] });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses delete permanently naming the assessments, until the assessment is deleted",
    async () => {
      const s = await seedApprovedAssessment(database, {
        ownerId: USER_A,
        title: "Ulangan Bab 1",
      });
      const [pinned] = s.questionIds;
      await trashQuestion(db(), { ownerId: USER_A, questionId: pinned, now: NOW });
      // A trashed assessment still pins it.
      await trashAssessment(db(), {
        ownerId: USER_A,
        assessmentId: s.assessmentId,
        now: NOW,
      });
      expect(
        await deletePermanently(db(), { ownerId: USER_A, questionId: pinned, now: NOW }),
      ).toEqual({ ok: false, error: { code: "inUse", assessments: ["Ulangan Bab 1"] } });
      expect(await exists(pinned)).toBe(true);
      expect(await database.db.select().from(deletionLog)).toEqual([]);

      await deleteAssessmentPermanently(db(), () => listingStore(), {
        ownerId: USER_A,
        assessmentId: s.assessmentId,
        now: NOW,
      });
      expect(
        await deletePermanently(db(), { ownerId: USER_A, questionId: pinned, now: NOW }),
      ).toMatchObject({ ok: true });
      expect(await exists(pinned)).toBe(false);
    },
    DB_TEST_TIMEOUT,
  );
});
