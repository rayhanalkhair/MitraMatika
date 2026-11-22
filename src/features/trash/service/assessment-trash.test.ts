import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assessmentItems,
  assessments,
  assessmentSections,
  deletionLog,
  exports,
  jobs,
  questions,
  questionUsages,
} from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { logger } from "@/lib/logger";
import type { AnyDb } from "@/features/generation";
import {
  getAssessmentEditor,
  listAssessments,
  updateAssessment,
  verifyApproval,
} from "@/features/assessments";
import { ASSESSMENT_INPUT } from "@/features/assessments/test-support";
import { getRecentAssessments } from "@/features/beranda";
import { requestExport } from "@/features/export";
import { asUser, seedApprovedAssessment } from "@/features/export/db-test-support";
import { clearTrashTables, listingStore, seedExportRun } from "../db-test-support";
import {
  deleteAssessmentPermanently,
  listTrashedAssessments,
  purgeExpiredAssessments,
  restoreAssessment,
  trashAssessment,
} from "./assessment-trash";

let database: TestDatabase;
const db = () => database.db as unknown as AnyDb;
const NOW = new Date("2026-11-20T03:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  await clearTrashTables(database);
});

const rowOf = async (id: string) =>
  (await database.db.select().from(assessments).where(eq(assessments.id, id))).at(0);
const countWhere = async (
  table: typeof assessmentSections | typeof assessmentItems | typeof exports,
  assessmentId: string,
) =>
  (await database.db.select().from(table).where(eq(table.assessmentId, assessmentId)))
    .length;
const usagesOf = async (assessmentId: string) =>
  (
    await database.db
      .select()
      .from(questionUsages)
      .where(eq(questionUsages.assessmentId, assessmentId))
  ).length;

/** An approved assessment of the owner with one export run (rows and files) and its usage. */
async function seedWithExport(
  store: ReturnType<typeof listingStore>,
  ownerId: string,
  title = "Ulangan Bab 1",
) {
  const seeded = await seedApprovedAssessment(database, { ownerId, title });
  const jobId = await seedExportRun(database, store, {
    ownerId,
    assessmentId: seeded.assessmentId,
    hash: seeded.hash,
  });
  const [question] = await database.db
    .select()
    .from(questions)
    .where(eq(questions.id, seeded.questionIds[0]));
  if (!question.currentVersionId) throw new Error("seeded question has no version");
  await database.db.insert(questionUsages).values({
    ownerId,
    questionId: question.id,
    questionVersionId: question.currentVersionId,
    assessmentId: seeded.assessmentId,
  });
  return { ...seeded, jobId };
}

describe("trashAssessment", () => {
  it(
    "moves the owner's assessment to the trash for 30 days and keeps its approval as it was",
    async () => {
      const store = listingStore();
      const s = await seedWithExport(store, USER_A);
      expect(
        await trashAssessment(db(), {
          ownerId: USER_A,
          assessmentId: s.assessmentId,
          now: NOW,
        }),
      ).toEqual({ ok: true, data: undefined });
      const row = await rowOf(s.assessmentId);
      expect(row?.deletedAt).toEqual(NOW);
      expect(row?.purgeAfter).toEqual(new Date(NOW.getTime() + 30 * DAY_MS));
      // Trashing does not reopen: the approval and its hash stay for a restore.
      expect(row?.status).toBe("approved");
      expect(row?.approvedSnapshotHash).toBe(s.hash);
      // Nothing is deleted yet.
      expect(await countWhere(exports, s.assessmentId)).toBe(2);
      expect(store.keys()).toHaveLength(2);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "takes it out of the builder list, the Home tile and the editor, and refuses edits and exports",
    async () => {
      const s = await seedApprovedAssessment(database, { ownerId: USER_A });
      await trashAssessment(db(), {
        ownerId: USER_A,
        assessmentId: s.assessmentId,
        now: NOW,
      });
      const visible = await asUser(database, USER_A, async (tx) => ({
        list: await listAssessments(tx, USER_A),
        recent: await getRecentAssessments(tx, { ownerId: USER_A }),
        editor: await getAssessmentEditor(tx, {
          ownerId: USER_A,
          assessmentId: s.assessmentId,
        }),
        update: await updateAssessment(tx, {
          ownerId: USER_A,
          assessmentId: s.assessmentId,
          input: { ...ASSESSMENT_INPUT, title: "Diubah" },
          expectedRowVersion: 1,
        }),
        gate: await verifyApproval(tx, { ownerId: USER_A, assessmentId: s.assessmentId }),
      }));
      expect(visible).toEqual({
        list: [],
        recent: [],
        editor: null,
        update: { ok: false, error: "notFound" },
        gate: { ok: false, error: "notFound" },
      });
      expect(
        await requestExport(database.db as never, {
          ownerId: USER_A,
          assessmentId: s.assessmentId,
          now: NOW,
        }),
      ).toEqual({ ok: false, error: { reason: "notFound" } });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "cancels the assessment's exports that have not started, and only those",
    async () => {
      const store = listingStore();
      const s = await seedApprovedAssessment(database, { ownerId: USER_A });
      const other = await seedApprovedAssessment(database, {
        ownerId: USER_A,
        title: "Lain",
      });
      const queued = await seedExportRun(database, store, {
        ...s,
        ownerId: USER_A,
        rows: false,
        status: "queued",
      });
      const running = await seedExportRun(database, store, {
        ...s,
        ownerId: USER_A,
        rows: false,
        status: "running",
      });
      const otherQueued = await seedExportRun(database, store, {
        ...other,
        ownerId: USER_A,
        rows: false,
        status: "queued",
      });
      await trashAssessment(db(), {
        ownerId: USER_A,
        assessmentId: s.assessmentId,
        now: NOW,
      });
      const statusOf = async (id: string) =>
        (await database.db.select().from(jobs).where(eq(jobs.id, id)))[0].status;
      expect(await statusOf(queued)).toBe("cancelled");
      // A running export re-checks the gate before it writes anything and then fails.
      expect(await statusOf(running)).toBe("running");
      expect(await statusOf(otherQueued)).toBe("queued");
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "is notFound for another teacher's, an unknown or an already trashed assessment",
    async () => {
      const s = await seedApprovedAssessment(database, { ownerId: USER_A });
      expect(
        await trashAssessment(db(), {
          ownerId: USER_B,
          assessmentId: s.assessmentId,
          now: NOW,
        }),
      ).toEqual({ ok: false, error: "notFound" });
      expect((await rowOf(s.assessmentId))?.deletedAt).toBeNull();
      await trashAssessment(db(), {
        ownerId: USER_A,
        assessmentId: s.assessmentId,
        now: NOW,
      });
      expect(
        await trashAssessment(db(), {
          ownerId: USER_A,
          assessmentId: s.assessmentId,
          now: new Date(NOW.getTime() + DAY_MS),
        }),
      ).toEqual({ ok: false, error: "notFound" });
      // The first trash time stands.
      expect((await rowOf(s.assessmentId))?.deletedAt).toEqual(NOW);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("restoreAssessment", () => {
  it(
    "brings it back exactly as it was: still approved and still exportable",
    async () => {
      const s = await seedApprovedAssessment(database, { ownerId: USER_A });
      const before = await rowOf(s.assessmentId);
      await trashAssessment(db(), {
        ownerId: USER_A,
        assessmentId: s.assessmentId,
        now: NOW,
      });
      expect(
        await restoreAssessment(db(), { ownerId: USER_A, assessmentId: s.assessmentId }),
      ).toEqual({ ok: true, data: undefined });
      const after = await rowOf(s.assessmentId);
      expect(after).toEqual({ ...before, updatedAt: after?.updatedAt });
      expect(
        await asUser(database, USER_A, (tx) =>
          verifyApproval(tx, { ownerId: USER_A, assessmentId: s.assessmentId }),
        ),
      ).toMatchObject({ ok: true, data: { hash: s.hash } });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "is notInTrash for a live one and notFound for another teacher's",
    async () => {
      const s = await seedApprovedAssessment(database, { ownerId: USER_A });
      expect(
        await restoreAssessment(db(), { ownerId: USER_A, assessmentId: s.assessmentId }),
      ).toEqual({ ok: false, error: "notInTrash" });
      await trashAssessment(db(), {
        ownerId: USER_A,
        assessmentId: s.assessmentId,
        now: NOW,
      });
      expect(
        await restoreAssessment(db(), { ownerId: USER_B, assessmentId: s.assessmentId }),
      ).toEqual({ ok: false, error: "notFound" });
      expect((await rowOf(s.assessmentId))?.deletedAt).toEqual(NOW);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("deleteAssessmentPermanently", () => {
  it(
    "deletes the assessment, its sections, items, exports, files and usage, and nothing of anyone else",
    async () => {
      const store = listingStore();
      const s = await seedWithExport(store, USER_A);
      // A failed run of the same assessment left files but no rows.
      const failedRun = await seedExportRun(database, store, {
        ...s,
        ownerId: USER_A,
        rows: false,
        status: "failed",
      });
      const kept = await seedWithExport(store, USER_A, "Ulangan Bab 2");
      const foreign = await seedWithExport(store, USER_B, "Punya B");
      const keysBefore = store.keys();
      await trashAssessment(db(), {
        ownerId: USER_A,
        assessmentId: s.assessmentId,
        now: NOW,
      });

      expect(
        await deleteAssessmentPermanently(db(), () => store, {
          ownerId: USER_A,
          assessmentId: s.assessmentId,
          now: NOW,
        }),
      ).toEqual({
        ok: true,
        data: { sections: 1, items: 3, exports: 2, exportFiles: 4, usages: 1 },
      });
      expect(await rowOf(s.assessmentId)).toBeUndefined();
      for (const table of [assessmentSections, assessmentItems, exports]) {
        expect(await countWhere(table, s.assessmentId)).toBe(0);
      }
      expect(await usagesOf(s.assessmentId)).toBe(0);
      // Its two runs' files are gone; every other object stays.
      expect(store.keys()).toEqual(
        keysBefore.filter(
          (key) =>
            !key.startsWith(`exports/${USER_A}/${s.jobId}/`) &&
            !key.startsWith(`exports/${USER_A}/${failedRun}/`),
        ),
      );
      expect(store.keys()).toHaveLength(4);
      expect(store.deletedPrefixes.sort()).toEqual(
        [`exports/${USER_A}/${s.jobId}/`, `exports/${USER_A}/${failedRun}/`].sort(),
      );
      for (const other of [kept, foreign]) {
        expect(await rowOf(other.assessmentId)).toBeDefined();
        expect(await countWhere(exports, other.assessmentId)).toBe(2);
      }
      // The questions it used stay in the bank.
      expect(
        await database.db
          .select()
          .from(questions)
          .where(eq(questions.id, s.questionIds[0])),
      ).toHaveLength(1);
      // Ids and counts only.
      const log = await database.db.select().from(deletionLog);
      expect(
        log.map((row) => [row.ownerId, row.entity, row.entityId, row.counts]),
      ).toEqual([
        [
          USER_A,
          "assessment",
          s.assessmentId,
          {
            assessments: 1,
            sections: 1,
            items: 3,
            exports: 2,
            exportRuns: 2,
            usages: 1,
          },
        ],
      ]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses an assessment that is not in the trash, and another teacher's, deleting nothing",
    async () => {
      const store = listingStore();
      const s = await seedWithExport(store, USER_A);
      expect(
        await deleteAssessmentPermanently(db(), () => store, {
          ownerId: USER_A,
          assessmentId: s.assessmentId,
          now: NOW,
        }),
      ).toEqual({ ok: false, error: "notInTrash" });
      await trashAssessment(db(), {
        ownerId: USER_A,
        assessmentId: s.assessmentId,
        now: NOW,
      });
      expect(
        await deleteAssessmentPermanently(db(), () => store, {
          ownerId: USER_B,
          assessmentId: s.assessmentId,
          now: NOW,
        }),
      ).toEqual({ ok: false, error: "notFound" });
      expect(await rowOf(s.assessmentId)).toBeDefined();
      expect(store.keys()).toHaveLength(2);
      expect(store.deletedPrefixes).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "keeps the row when its files cannot be deleted, so a later try finishes the job",
    async () => {
      const failing = { on: true };
      const store = listingStore({ failPrefix: () => failing.on });
      const s = await seedWithExport(store, USER_A);
      await trashAssessment(db(), {
        ownerId: USER_A,
        assessmentId: s.assessmentId,
        now: NOW,
      });
      await expect(
        deleteAssessmentPermanently(db(), () => store, {
          ownerId: USER_A,
          assessmentId: s.assessmentId,
          now: NOW,
        }),
      ).rejects.toThrow("storage unavailable");
      expect((await rowOf(s.assessmentId))?.deletedAt).toEqual(NOW);
      expect(await countWhere(exports, s.assessmentId)).toBe(2);
      expect(await database.db.select().from(deletionLog)).toEqual([]);

      failing.on = false;
      expect(
        await deleteAssessmentPermanently(db(), () => store, {
          ownerId: USER_A,
          assessmentId: s.assessmentId,
          now: NOW,
        }),
      ).toMatchObject({ ok: true });
      expect(store.keys()).toEqual([]);
      expect(
        await restoreAssessment(db(), { ownerId: USER_A, assessmentId: s.assessmentId }),
      ).toEqual({
        ok: false,
        error: "notFound",
      });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "never asks for the object store when the assessment has no export files",
    async () => {
      const s = await seedApprovedAssessment(database, { ownerId: USER_A });
      await trashAssessment(db(), {
        ownerId: USER_A,
        assessmentId: s.assessmentId,
        now: NOW,
      });
      const noStore = vi.fn(() => {
        throw new Error("no store configured");
      });
      expect(
        await deleteAssessmentPermanently(db(), noStore, {
          ownerId: USER_A,
          assessmentId: s.assessmentId,
          now: NOW,
        }),
      ).toEqual({
        ok: true,
        data: { sections: 1, items: 3, exports: 0, exportFiles: 0, usages: 0 },
      });
      expect(noStore).not.toHaveBeenCalled();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "never sends a key outside the owner's export prefix to storage",
    async () => {
      const store = listingStore();
      const s = await seedApprovedAssessment(database, { ownerId: USER_A });
      const victim = `exports/${USER_B}/44444444-4444-4444-8444-444444444444/paper.pdf`;
      await store.put(victim, new Uint8Array([9]), "application/pdf");
      // A row without a job whose key was rewritten to another teacher's object.
      await database.db.insert(exports).values({
        ownerId: USER_A,
        assessmentId: s.assessmentId,
        document: "paper",
        format: "pdf",
        objectKey: victim,
        snapshotHash: s.hash,
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      });
      await trashAssessment(db(), {
        ownerId: USER_A,
        assessmentId: s.assessmentId,
        now: NOW,
      });
      const warned = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      expect(
        await deleteAssessmentPermanently(db(), () => store, {
          ownerId: USER_A,
          assessmentId: s.assessmentId,
          now: NOW,
        }),
      ).toMatchObject({ ok: true, data: { exports: 1, exportFiles: 0 } });
      expect(JSON.stringify(warned.mock.calls)).not.toContain(victim);
      warned.mockRestore();
      expect(store.keys()).toEqual([victim]);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("purgeExpiredAssessments", () => {
  it(
    "purges the expired ones of every owner, twice is a no-op, and a failing one does not stop the others",
    async () => {
      const store = listingStore({
        failPrefix: (prefix) => prefix.includes(failingJob.id),
      });
      const failingJob = { id: "none" };
      const young = await seedWithExport(store, USER_A, "Muda");
      const old = await seedWithExport(store, USER_A, "Lama");
      const failing = await seedWithExport(store, USER_B, "Gagal");
      const live = await seedWithExport(store, USER_B, "Hidup");
      failingJob.id = failing.jobId;
      await trashAssessment(db(), {
        ownerId: USER_A,
        assessmentId: old.assessmentId,
        now: NOW,
      });
      await trashAssessment(db(), {
        ownerId: USER_B,
        assessmentId: failing.assessmentId,
        now: NOW,
      });
      await trashAssessment(db(), {
        ownerId: USER_A,
        assessmentId: young.assessmentId,
        now: new Date(NOW.getTime() + 5 * DAY_MS),
      });

      expect(
        await purgeExpiredAssessments(
          db(),
          () => store,
          new Date(NOW.getTime() + 29 * DAY_MS),
        ),
      ).toEqual({ purged: 0, failed: 0 });

      const day30 = new Date(NOW.getTime() + 30 * DAY_MS);
      const logged = vi.spyOn(logger, "error").mockImplementation(() => undefined);
      expect(await purgeExpiredAssessments(db(), () => store, day30)).toEqual({
        purged: 1,
        failed: 1,
      });
      expect(logged.mock.calls).toEqual([
        [
          {
            module: "trash",
            assessmentId: failing.assessmentId,
            err: { name: "Error", code: null },
          },
          "trash: could not purge an assessment",
        ],
      ]);
      logged.mockRestore();
      expect(await rowOf(old.assessmentId)).toBeUndefined();
      expect(await rowOf(failing.assessmentId)).toBeDefined();
      expect(await countWhere(exports, failing.assessmentId)).toBe(2);
      expect(await rowOf(young.assessmentId)).toBeDefined();
      expect(await rowOf(live.assessmentId)).toBeDefined();
      expect(store.keys().some((key) => key.includes(old.jobId))).toBe(false);
      expect(store.keys().filter((key) => key.includes(failing.jobId))).toHaveLength(2);

      failingJob.id = "none";
      expect(await purgeExpiredAssessments(db(), () => store, day30)).toEqual({
        purged: 1,
        failed: 0,
      });
      expect(await purgeExpiredAssessments(db(), () => store, day30)).toEqual({
        purged: 0,
        failed: 0,
      });
      expect(
        (await database.db.select().from(deletionLog)).map((row) => row.entityId).sort(),
      ).toEqual([old.assessmentId, failing.assessmentId].sort());
    },
    DB_TEST_TIMEOUT,
  );
});

describe("listTrashedAssessments", () => {
  it(
    "lists the owner's trashed assessments only, newest first, with what a delete would take",
    async () => {
      const store = listingStore();
      const first = await seedWithExport(store, USER_A, "Pertama");
      const second = await seedApprovedAssessment(database, {
        ownerId: USER_A,
        title: "Kedua",
        count: 2,
      });
      await seedApprovedAssessment(database, { ownerId: USER_A, title: "Hidup" });
      const foreign = await seedApprovedAssessment(database, { ownerId: USER_B });
      await trashAssessment(db(), {
        ownerId: USER_A,
        assessmentId: first.assessmentId,
        now: NOW,
      });
      await trashAssessment(db(), {
        ownerId: USER_A,
        assessmentId: second.assessmentId,
        now: new Date(NOW.getTime() + 2 * DAY_MS),
      });
      await trashAssessment(db(), {
        ownerId: USER_B,
        assessmentId: foreign.assessmentId,
        now: NOW,
      });
      const listed = await asUser(database, USER_A, (tx) =>
        listTrashedAssessments(tx, {
          ownerId: USER_A,
          now: new Date(NOW.getTime() + 2 * DAY_MS),
        }),
      );
      expect(listed).toEqual([
        {
          assessmentId: second.assessmentId,
          title: "Kedua",
          approved: true,
          sectionCount: 1,
          itemCount: 2,
          exportCount: 0,
          usageCount: 0,
          deletedAt: new Date(NOW.getTime() + 2 * DAY_MS).toISOString(),
          purgeAfter: new Date(NOW.getTime() + 32 * DAY_MS).toISOString(),
          daysLeft: 30,
        },
        {
          assessmentId: first.assessmentId,
          title: "Pertama",
          approved: true,
          sectionCount: 1,
          itemCount: 3,
          exportCount: 2,
          usageCount: 1,
          deletedAt: NOW.toISOString(),
          purgeAfter: new Date(NOW.getTime() + 30 * DAY_MS).toISOString(),
          daysLeft: 28,
        },
      ]);
      const ofB = await database.db
        .select()
        .from(assessments)
        .where(and(eq(assessments.ownerId, USER_B)));
      expect(ofB).toHaveLength(1);
    },
    DB_TEST_TIMEOUT,
  );
});
