import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { exports, jobs } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { createJobQueue } from "@/lib/jobs/queue";
import { clearAll } from "@/features/assessments/test-support";
import {
  asUser,
  reapproveChanged,
  recordingStore,
  seedApprovedAssessment,
} from "../db-test-support";
import { createRenderExportHandler, EXPORT_TTL_MS } from "./export-job";
import { getExportPanel } from "./export-panel";
import { requestExport } from "./request-export";

let database: TestDatabase;
const NOW = new Date("2026-11-20T03:00:00.000Z");
const pdf = () =>
  Promise.resolve({
    bytes: new TextEncoder().encode("%PDF-1.7\n<< /Type /Page >>"),
    pages: 1,
    warnings: [],
  });

async function exportOnce(assessmentId: string) {
  const db = database.db as never;
  const requested = await requestExport(db, { ownerId: USER_A, assessmentId, now: NOW });
  if (!requested.ok) throw new Error("export refused");
  const job = await createJobQueue(database.db, () => NOW).claimNext();
  if (!job) throw new Error("no job");
  await createRenderExportHandler({
    db,
    store: recordingStore(),
    renderPdf: pdf,
    now: () => NOW,
  })({
    job,
    ownerId: USER_A,
    progress: null,
    correlationId: job.correlationId,
    deadline: Date.now() + 240_000,
  });
  await database.db.update(jobs).set({ status: "succeeded" }).where(eq(jobs.id, job.id));
  return job.id;
}

let currentHash = "";
const panel = (userId: string, assessmentId: string, now = NOW, hash = currentHash) =>
  asUser(database, userId, (tx) =>
    getExportPanel(tx, { ownerId: userId, assessmentId, snapshotHash: hash, now }),
  );

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  await clearAll(database);
  currentHash = "";
});

describe("getExportPanel", () => {
  it(
    "lists the newest export's seven files in order, with the latest job",
    async () => {
      const { assessmentId, hash } = await seedApprovedAssessment(database, {
        ownerId: USER_A,
      });
      currentHash = hash;
      expect(await panel(USER_A, assessmentId)).toEqual({
        job: null,
        files: [],
        expired: false,
      });
      const jobId = await exportOnce(assessmentId);
      const data = await panel(USER_A, assessmentId);
      expect(data.job).toEqual({ id: jobId, status: "succeeded", errorCode: null });
      expect(data.files.map((f) => `${f.document}.${f.format}`)).toEqual([
        "paper.pdf",
        "paper.docx",
        "key.pdf",
        "key.docx",
        "solutions.pdf",
        "solutions.docx",
        "zip.zip",
      ]);
      expect(data.files[0].expiresAt).toBe(
        new Date(NOW.getTime() + EXPORT_TTL_MS).toISOString(),
      );
      expect(data.expired).toBe(false);
      expect(
        (await panel(USER_A, assessmentId, new Date(NOW.getTime() + EXPORT_TTL_MS)))
          .expired,
      ).toBe(true);
      // Another teacher sees nothing of it.
      expect(await panel(USER_B, assessmentId)).toEqual({
        job: null,
        files: [],
        expired: false,
      });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "shows the code of a failed export and keeps only readable warnings, without sources",
    async () => {
      const { assessmentId, hash } = await seedApprovedAssessment(database, {
        ownerId: USER_A,
      });
      currentHash = hash;
      const jobId = await exportOnce(assessmentId);
      await database.db
        .update(exports)
        .set({
          warnings: [
            { code: "mathFailed", where: { part: "stem", number: 2 }, source: "\\bad" },
            { code: "mathTooWide", where: { part: "stem", number: 4 }, source: "a+b" },
            {
              code: "logoOmitted",
              where: { part: "letterhead" },
              source: "image/svg+xml",
            },
            { code: "logoMissing", where: { part: "letterhead" } },
            { code: "somethingElse" },
            "junk",
          ],
        })
        .where(eq(exports.jobId, jobId));
      await database.db
        .update(jobs)
        .set({ status: "failed", error: { code: "export_too_large", message: "x" } })
        .where(eq(jobs.id, jobId));
      const data = await panel(USER_A, assessmentId);
      expect(data.job).toEqual({
        id: jobId,
        status: "failed",
        errorCode: "export_too_large",
      });
      expect(data.files[0].warnings).toEqual([
        { code: "mathFailed", where: { part: "stem", number: 2 } },
        { code: "mathTooWide", where: { part: "stem", number: 4 } },
        { code: "logoOmitted" },
        { code: "logoMissing" },
      ]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "offers nothing of an earlier approval after reopen, change and approve (R27)",
    async () => {
      const { assessmentId, hash } = await seedApprovedAssessment(database, {
        ownerId: USER_A,
      });
      const jobId = await exportOnce(assessmentId);
      // The earlier run failed afterwards: its failure must not show on the new approval either.
      await database.db
        .update(jobs)
        .set({ status: "failed", error: { code: "export_stale", message: "x" } })
        .where(eq(jobs.id, jobId));
      expect((await panel(USER_A, assessmentId, NOW, hash)).files).toHaveLength(7);

      const fresh = await reapproveChanged(database, { ownerId: USER_A, assessmentId });
      expect(fresh).not.toBe(hash);
      expect(await panel(USER_A, assessmentId, NOW, fresh)).toEqual({
        job: null,
        files: [],
        expired: false,
      });

      // An export of the new approval is listed, and only its files.
      const second = await exportOnce(assessmentId);
      const data = await panel(USER_A, assessmentId, NOW, fresh);
      expect(data.job?.id).toBe(second);
      expect(data.files).toHaveLength(7);
      expect(new Set(data.files.map((file) => file.id)).size).toBe(7);
      const ids = await database.db
        .select({ id: exports.id })
        .from(exports)
        .where(eq(exports.jobId, second));
      expect(data.files.map((file) => file.id).sort()).toEqual(
        ids.map((row) => row.id).sort(),
      );
    },
    DB_TEST_TIMEOUT,
  );
});
