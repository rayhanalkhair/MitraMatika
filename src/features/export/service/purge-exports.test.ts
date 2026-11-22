import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exports, questionUsages } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { logger } from "@/lib/logger";
import type { ObjectStore } from "@/lib/storage/types";
import type { AssessmentDb } from "@/features/assessments";
import { clearAll } from "@/features/assessments/test-support";
import { recordingStore, seedApprovedAssessment } from "../db-test-support";
import { isOwnExportKey } from "./file-names";
import { purgeExpiredExports } from "./purge-exports";

let database: TestDatabase;
const db = () => database.db as unknown as AssessmentDb;
const NOW = new Date("2026-11-20T03:00:00.000Z");
const JOB = "33333333-3333-4333-8333-333333333333";
const key = (name: string) => `exports/${USER_A}/${JOB}/${name}`;

async function seed(store: ReturnType<typeof recordingStore>) {
  const seeded = await seedApprovedAssessment(database, { ownerId: USER_A });
  const row = async (name: string, expiresAt: Date, objectKey = key(name)) => {
    await store.put(objectKey, new Uint8Array([1]), "application/pdf");
    const [inserted] = await database.db
      .insert(exports)
      .values({
        ownerId: USER_A,
        assessmentId: seeded.assessmentId,
        document: "paper",
        format: "pdf",
        objectKey,
        snapshotHash: seeded.hash,
        expiresAt,
      })
      .returning({ id: exports.id });
    return inserted.id;
  };
  return { seeded, row };
}

const remaining = async () =>
  (await database.db.select({ key: exports.objectKey }).from(exports))
    .map((r) => r.key)
    .sort();

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  await clearAll(database);
});

describe("purgeExpiredExports", () => {
  it(
    "deletes the objects and rows of expired exports and keeps the live ones and the usage",
    async () => {
      const store = recordingStore();
      const { seeded, row } = await seed(store);
      const expiredId = await row("old.pdf", new Date(NOW.getTime() - 1));
      await row("edge.pdf", NOW);
      await row("live.pdf", new Date(NOW.getTime() + 60_000));
      const [question] = seeded.questionIds;
      const [version] = await database.db
        .execute<{ id: string }>(
          `select current_version_id as id from questions where id = '${question}'`,
        )
        .then((r) => (r as unknown as { rows: { id: string }[] }).rows);
      await database.db.insert(questionUsages).values({
        ownerId: USER_A,
        questionId: question,
        questionVersionId: version.id,
        assessmentId: seeded.assessmentId,
        exportId: expiredId,
      });

      expect(await purgeExpiredExports(db(), store, NOW)).toEqual({
        purged: 2,
        failed: 0,
      });
      expect(store.keys()).toEqual([key("live.pdf")]);
      expect(await remaining()).toEqual([key("live.pdf")]);
      // The usage history outlives the purge of its export (SET NULL).
      const usages = await database.db
        .select()
        .from(questionUsages)
        .where(eq(questionUsages.assessmentId, seeded.assessmentId));
      expect(usages).toHaveLength(1);
      expect(usages[0].exportId).toBeNull();

      // Idempotent: nothing left to do.
      expect(await purgeExpiredExports(db(), store, NOW)).toEqual({
        purged: 0,
        failed: 0,
      });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "keeps a row whose object could not be deleted and purges the others",
    async () => {
      const store = recordingStore({ failDeleteOf: (k) => k.endsWith("stuck.pdf") });
      const { row } = await seed(store);
      const past = new Date(NOW.getTime() - 60_000);
      await row("a.pdf", past);
      await row("stuck.pdf", past);
      await row("b.pdf", past);
      expect(await purgeExpiredExports(db(), store, NOW)).toEqual({
        purged: 2,
        failed: 1,
      });
      expect(store.keys()).toEqual([key("stuck.pdf")]);
      // Retried on the next run.
      expect(await remaining()).toEqual([key("stuck.pdf")]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "never touches an object outside the owner's export prefix, but drops the row",
    async () => {
      const store = recordingStore();
      const { row } = await seed(store);
      const foreign = "templates/someone/else/logo.png";
      await row("x", new Date(NOW.getTime() - 1), foreign);
      expect(await purgeExpiredExports(db(), store, NOW)).toEqual({
        purged: 1,
        failed: 0,
      });
      expect(store.keys()).toEqual([foreign]);
      expect(await remaining()).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("isOwnExportKey", () => {
  it.each([
    [`exports/${USER_A}/${JOB}/paper.pdf`, true],
    [`exports/${USER_A}/../x/paper.pdf`, false],
    [`exports/22222222-2222-2222-2222-222222222222/${JOB}/paper.pdf`, false],
    [`templates/${USER_A}/t/logo.png`, false],
    [`exports/${USER_A}`, false],
  ])("%s -> %s", (value, expected) => {
    expect(isOwnExportKey(USER_A, value)).toBe(expected);
  });
});

describe("purgeExpiredExports bounds (the daily run's budget)", () => {
  it(
    "stops after its time budget and leaves the rest for the next run",
    async () => {
      const store = recordingStore();
      const { row } = await seed(store);
      // Oldest expiry first.
      for (const [index, name] of ["a.pdf", "b.pdf", "c.pdf"].entries()) {
        await row(name, new Date(NOW.getTime() - 3 + index));
      }
      let clock = 0;
      const slow: ObjectStore = {
        ...store,
        delete: async (objectKey) => {
          clock += 20_000;
          await store.delete(objectKey);
        },
      };
      const onBacklog = vi.fn();
      expect(
        await purgeExpiredExports(db(), slow, NOW, {
          budgetMs: 30_000,
          clock: () => clock,
          onBacklog,
        }),
      ).toEqual({ purged: 2, failed: 0 });
      expect(await remaining()).toEqual([key("c.pdf")]);
      // Stopped by its budget with a row left: the daily run's record says so.
      expect(onBacklog).toHaveBeenCalledTimes(1);
      const done = vi.fn();
      await purgeExpiredExports(db(), store, NOW, { onBacklog: done });
      expect(done).not.toHaveBeenCalled();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "fails a row whose store call hangs, within a bound, and goes on",
    async () => {
      const store = recordingStore();
      const { row } = await seed(store);
      await row("hung.pdf", new Date(NOW.getTime() - 2));
      await row("fine.pdf", new Date(NOW.getTime() - 1));
      const hung: ObjectStore = {
        ...store,
        delete: (objectKey) =>
          objectKey.endsWith("hung.pdf")
            ? new Promise<void>(() => undefined)
            : store.delete(objectKey),
      };
      vi.spyOn(logger, "error").mockImplementation(() => undefined);
      expect(await purgeExpiredExports(db(), hung, NOW, { storeTimeoutMs: 50 })).toEqual({
        purged: 1,
        failed: 1,
      });
      expect(await remaining()).toEqual([key("hung.pdf")]);
      vi.restoreAllMocks();
    },
    DB_TEST_TIMEOUT,
  );
});
