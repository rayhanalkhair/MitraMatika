// How a permanent delete orders the database and the object store, and how one daily run is
// bounded: a row's files go only after its rows and its deletion_log entry are written, every row
// commits on its own, and a hung store call fails its row instead of stalling the daily run.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assessments, auditLog, questions, schoolTemplates } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { logger } from "@/lib/logger";
import type { ObjectStore } from "@/lib/storage/types";
import type { AnyDb } from "@/features/generation";
import { seedApprovedAssessment } from "@/features/export/db-test-support";
import { clearTrashTables, listingStore, seedExportRun } from "../db-test-support";
import { deleteAssessmentPermanently, trashAssessment } from "./assessment-trash";
import { purgeTrashOncePerDay } from "./purge";
import { deleteTemplatePermanently, trashTemplate } from "./template-trash";
import { trashQuestion } from "./trash";

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

// A check even the superuser cannot bypass: the deletion_log entry of this one row fails.
const blockLogOf = (entityId: string) =>
  database.db.execute(
    `alter table deletion_log add constraint deletion_log_test_block check (entity_id <> '${entityId}') not valid`,
  );
const unblockLog = () =>
  database.db.execute(`alter table deletion_log drop constraint deletion_log_test_block`);

const assessmentRow = async (id: string) =>
  (await database.db.select().from(assessments).where(eq(assessments.id, id))).at(0);

async function trashedAssessmentWithExport(store: ReturnType<typeof listingStore>) {
  const s = await seedApprovedAssessment(database, { ownerId: USER_A });
  const jobId = await seedExportRun(database, store, {
    ownerId: USER_A,
    assessmentId: s.assessmentId,
    hash: s.hash,
  });
  await trashAssessment(db(), {
    ownerId: USER_A,
    assessmentId: s.assessmentId,
    now: NOW,
  });
  return { ...s, jobId };
}

describe("a permanent delete whose database write fails", () => {
  it(
    "never touches the assessment's files",
    async () => {
      const store = listingStore();
      const s = await trashedAssessmentWithExport(store);
      const keys = store.keys();
      await blockLogOf(s.assessmentId);
      try {
        await expect(
          deleteAssessmentPermanently(db(), () => store, {
            ownerId: USER_A,
            assessmentId: s.assessmentId,
            now: NOW,
          }),
        ).rejects.toThrow();
      } finally {
        await unblockLog();
      }
      expect(await assessmentRow(s.assessmentId)).toBeDefined();
      expect(store.keys()).toEqual(keys);
      expect(store.deletedPrefixes).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "never touches the template's logo",
    async () => {
      const store = listingStore();
      const [template] = await database.db
        .insert(schoolTemplates)
        .values({ ownerId: USER_A, name: "Kop", schoolName: "SMP" })
        .returning({ id: schoolTemplates.id });
      const key = `templates/${USER_A}/${template.id}/logo.png`;
      await store.put(key, new Uint8Array([1]), "image/png");
      await database.db
        .update(schoolTemplates)
        .set({ logoKey: key })
        .where(eq(schoolTemplates.id, template.id));
      await trashTemplate(db(), { ownerId: USER_A, templateId: template.id, now: NOW });
      await blockLogOf(template.id);
      try {
        await expect(
          deleteTemplatePermanently(db(), () => store, {
            ownerId: USER_A,
            templateId: template.id,
            now: NOW,
          }),
        ).rejects.toThrow();
      } finally {
        await unblockLog();
      }
      expect(store.keys()).toEqual([key]);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("purgeTrashOncePerDay", () => {
  it(
    "never leaves a row in the trash whose files are already gone when the run itself fails",
    async () => {
      const store = listingStore();
      const first = await trashedAssessmentWithExport(store);
      const second = await trashedAssessmentWithExport(store);
      // The day's marker cannot be written.
      await database.db.execute(
        `alter table audit_log add constraint audit_log_test_block check (action <> 'trash_purged') not valid`,
      );
      try {
        await expect(purgeTrashOncePerDay(db(), DAY30, () => store)).rejects.toThrow();
      } finally {
        await database.db.execute(
          `alter table audit_log drop constraint audit_log_test_block`,
        );
      }
      // Each row is either gone with its files, or still there with all of them.
      for (const s of [first, second]) {
        const files = store.keys().filter((key) => key.includes(s.jobId));
        if (await assessmentRow(s.assessmentId)) expect(files).toHaveLength(2);
        else expect(files).toEqual([]);
      }
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "commits each row on its own: a row that fails keeps its files, the others stay purged",
    async () => {
      const store = listingStore();
      const purged = await trashedAssessmentWithExport(store);
      const failing = await trashedAssessmentWithExport(store);
      await blockLogOf(failing.assessmentId);
      const logged = vi.spyOn(logger, "error").mockImplementation(() => undefined);
      try {
        expect(await purgeTrashOncePerDay(db(), DAY30, () => store)).toEqual({
          purged: 1,
          failed: 1,
        });
      } finally {
        await unblockLog();
        logged.mockRestore();
      }
      expect(await assessmentRow(purged.assessmentId)).toBeUndefined();
      expect(store.keys().filter((key) => key.includes(purged.jobId))).toEqual([]);
      expect(await assessmentRow(failing.assessmentId)).toBeDefined();
      expect(store.keys().filter((key) => key.includes(failing.jobId))).toHaveLength(2);
      const marks = await database.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "trash_purged"));
      expect(marks.map((row) => row.metadata)).toEqual([
        { day: "2026-12-20", purged: 1, failed: 1 },
      ]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "fails a row whose store call hangs, within a bound, and leaves it in the trash",
    async () => {
      const inner = listingStore();
      const s = await trashedAssessmentWithExport(inner);
      const hung: ObjectStore = {
        ...inner,
        deletePrefix: () => new Promise<number>(() => undefined),
      };
      const logged = vi.spyOn(logger, "error").mockImplementation(() => undefined);
      const started = Date.now();
      try {
        const result = await Promise.race([
          purgeTrashOncePerDay(db(), DAY30, () => hung, { storeTimeoutMs: 100 }),
          new Promise<"hung">((resolve) =>
            setTimeout(() => {
              resolve("hung");
            }, 5_000),
          ),
        ]);
        expect(result).toEqual({ purged: 0, failed: 1 });
      } finally {
        logged.mockRestore();
      }
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(await assessmentRow(s.assessmentId)).toBeDefined();
      expect(inner.keys()).toHaveLength(2);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "stops taking rows once its time budget is spent; the rest stay for the next day",
    async () => {
      const store = listingStore();
      const first = await trashedAssessmentWithExport(store);
      const second = await trashedAssessmentWithExport(store);
      // A fake clock: every store call takes 40 s of a 60 s budget.
      let clock = 0;
      const slow: ObjectStore = {
        ...store,
        deletePrefix: async (prefix) => {
          clock += 40_000;
          return store.deletePrefix(prefix);
        },
      };
      const result = await purgeTrashOncePerDay(db(), DAY30, () => slow, {
        budgetMs: 60_000,
        clock: () => clock,
      });
      // The first assessment took 40 s (past its share of the minute); the second went in the
      // second pass with the time the other kinds left (it started inside the budget).
      expect(result).toEqual({ purged: 2, failed: 0 });
      expect(await assessmentRow(first.assessmentId)).toBeUndefined();
      expect(await assessmentRow(second.assessmentId)).toBeUndefined();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "takes no row after the budget, so the leftovers wait without failing",
    async () => {
      const store = listingStore();
      const first = await trashedAssessmentWithExport(store);
      const second = await trashedAssessmentWithExport(store);
      let clock = 0;
      const slow: ObjectStore = {
        ...store,
        deletePrefix: async (prefix) => {
          clock += 61_000;
          return store.deletePrefix(prefix);
        },
      };
      expect(
        await purgeTrashOncePerDay(db(), DAY30, () => slow, {
          budgetMs: 60_000,
          clock: () => clock,
        }),
      ).toEqual({ purged: 1, failed: 0 });
      const rows = await Promise.all(
        [first, second].map((s) => assessmentRow(s.assessmentId)),
      );
      expect(rows.filter((row) => row !== undefined)).toHaveLength(1);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("purgeTrashOncePerDay keeps dependent kinds in order on every day", () => {
  it(
    "purges an expired assessment and the question and template it pinned in the same run, every day of the rotation",
    async () => {
      for (let day = 0; day < 8; day += 1) {
        await clearTrashTables(database);
        const trashedAt = new Date(NOW.getTime() + day * 24 * 60 * 60 * 1000);
        const runAt = new Date(trashedAt.getTime() + 31 * 24 * 60 * 60 * 1000);
        const s = await seedApprovedAssessment(database, { ownerId: USER_A, count: 1 });
        await trashAssessment(db(), {
          ownerId: USER_A,
          assessmentId: s.assessmentId,
          now: trashedAt,
        });
        await trashTemplate(db(), {
          ownerId: USER_A,
          templateId: s.templateId,
          now: trashedAt,
        });
        await trashQuestion(db(), {
          ownerId: USER_A,
          questionId: s.questionIds[0],
          now: trashedAt,
        });
        const store = listingStore();
        await purgeTrashOncePerDay(db(), runAt, () => store);
        expect(await assessmentRow(s.assessmentId), `day ${String(day)}`).toBeUndefined();
        expect(
          await database.db
            .select()
            .from(schoolTemplates)
            .where(eq(schoolTemplates.id, s.templateId)),
          `day ${String(day)}`,
        ).toEqual([]);
        expect(
          await database.db
            .select()
            .from(questions)
            .where(eq(questions.id, s.questionIds[0])),
          `day ${String(day)}`,
        ).toEqual([]);
      }
    },
    4 * DB_TEST_TIMEOUT,
  );
});
