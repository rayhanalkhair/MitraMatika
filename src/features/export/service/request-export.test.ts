import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { jobs } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { reopen, type AssessmentDb } from "@/features/assessments";
import { clearAll } from "@/features/assessments/test-support";
import { asUser, seedApprovedAssessment } from "../db-test-support";
import { EXPORT_JOB_TYPE } from "./export-job";
import { EXPORT_HOURLY_LIMIT, requestExport } from "./request-export";

let database: TestDatabase;
const db = () => database.db as unknown as AssessmentDb;
const NOW = new Date("2026-11-20T03:00:00.000Z");
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  await clearAll(database);
});

describe("requestExport", () => {
  it(
    "queues a render_export job carrying the approved snapshot's hash",
    async () => {
      const seeded = await seedApprovedAssessment(database, { ownerId: USER_A });
      const result = await requestExport(db(), {
        ownerId: USER_A,
        assessmentId: seeded.assessmentId,
        now: NOW,
      });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const [job] = await database.db
        .select()
        .from(jobs)
        .where(eq(jobs.id, result.data.jobId));
      expect(job).toMatchObject({
        ownerId: USER_A,
        type: EXPORT_JOB_TYPE,
        status: "queued",
        payload: { assessmentId: seeded.assessmentId, snapshotHash: seeded.hash },
      });
      expect(job.createdAt.getTime()).toBe(NOW.getTime());
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses an assessment that is not approved, and another teacher's",
    async () => {
      const seeded = await seedApprovedAssessment(database, { ownerId: USER_A });
      expect(
        await requestExport(db(), {
          ownerId: USER_B,
          assessmentId: seeded.assessmentId,
          now: NOW,
        }),
      ).toEqual({ ok: false, error: { reason: "notFound" } });
      await asUser(database, USER_A, (tx) =>
        reopen(tx, { ownerId: USER_A, assessmentId: seeded.assessmentId }),
      );
      expect(
        await requestExport(db(), {
          ownerId: USER_A,
          assessmentId: seeded.assessmentId,
          now: NOW,
        }),
      ).toEqual({ ok: false, error: { reason: "notApproved" } });
      expect(
        await database.db.select().from(jobs).where(eq(jobs.type, EXPORT_JOB_TYPE)),
      ).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "answers with the pending job instead of queueing a second one",
    async () => {
      const seeded = await seedApprovedAssessment(database, { ownerId: USER_A });
      const input = { ownerId: USER_A, assessmentId: seeded.assessmentId, now: NOW };
      const first = await requestExport(db(), input);
      if (!first.ok) throw new Error("first export refused");
      expect(await requestExport(db(), { ...input, now: minutes(1) })).toEqual({
        ok: false,
        error: { reason: "pending", jobId: first.data.jobId },
      });
      // Once it has finished, a new export may start.
      await database.db
        .update(jobs)
        .set({ status: "succeeded" })
        .where(eq(jobs.id, first.data.jobId));
      expect((await requestExport(db(), { ...input, now: minutes(2) })).ok).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "allows 10 exports per hour per teacher and says when the next one is possible",
    async () => {
      const seeded = await seedApprovedAssessment(database, { ownerId: USER_A });
      const input = { ownerId: USER_A, assessmentId: seeded.assessmentId };
      for (let i = 0; i < EXPORT_HOURLY_LIMIT; i += 1) {
        const result = await requestExport(db(), { ...input, now: minutes(i) });
        if (!result.ok) throw new Error(`export ${String(i)} refused`);
        await database.db
          .update(jobs)
          .set({ status: "failed" })
          .where(eq(jobs.id, result.data.jobId));
      }
      expect(EXPORT_HOURLY_LIMIT).toBe(10);
      expect(await requestExport(db(), { ...input, now: minutes(30) })).toEqual({
        ok: false,
        error: { reason: "hourlyLimit", limit: 10, resetsAt: minutes(60) },
      });
      // An hour after the first one, one slot is free again.
      expect((await requestExport(db(), { ...input, now: minutes(60) })).ok).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );
});
