import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { logger } from "@/lib/logger";
import { JOBS_RUN_ACTION, recordRun } from "./run-record";
import type { RunSummary } from "./runner";
import type { TickResult } from "./tick";

let database: TestDatabase;
const AT = new Date("2026-11-22T19:12:00.000Z");

const SUMMARY: RunSummary = {
  ran: 3,
  succeeded: 2,
  continued: 0,
  deferred: 1,
  retried: 0,
  failed: 0,
  lostLease: 0,
  reclaimed: 0,
  budgetExhausted: false,
};

const RESULT: TickResult = {
  steps: [
    { name: "settleRegenerations", outcome: "ran", ms: 120 },
    { name: "purgeTrash", outcome: "ran", ms: 61_000, backlogLeft: true },
    { name: "purgeExports", outcome: "failed", ms: 15 },
    { name: "sweepSolver", outcome: "skipped", ms: 0 },
  ],
  jobs: SUMMARY,
  budgetMs: 178_865,
};

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  await database.db.delete(auditLog);
  vi.restoreAllMocks();
});

describe("recordRun", () => {
  it(
    "writes one ownerless jobs_run row with step names, outcomes and ms, and no ids",
    async () => {
      await recordRun(database.db, { at: AT, trigger: "cron", result: RESULT });
      const rows = await database.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, JOBS_RUN_ACTION));
      expect(JOBS_RUN_ACTION).toBe("jobs_run");
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row.ownerId).toBeNull();
      expect(row.entityType).toBeNull();
      expect(row.entityId).toBeNull();
      expect(row.createdAt.toISOString()).toBe(AT.toISOString());
      expect(row.metadata).toEqual({
        trigger: "cron",
        steps: [
          { name: "settleRegenerations", outcome: "ran", ms: 120 },
          { name: "purgeTrash", outcome: "ran", ms: 61_000, backlogLeft: true },
          { name: "purgeExports", outcome: "failed", ms: 15 },
          { name: "sweepSolver", outcome: "skipped", ms: 0 },
        ],
        jobs: { ran: 3, budgetMs: 178_865 },
      });
      // No uuid anywhere in the record.
      expect(JSON.stringify(row.metadata)).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      );
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "records jobs as null when the runner was skipped, and a manual trigger",
    async () => {
      await recordRun(database.db, {
        at: AT,
        trigger: "manual",
        result: { ...RESULT, jobs: null, budgetMs: 20_000 },
      });
      const [row] = await database.db.select().from(auditLog);
      expect(row.metadata).toMatchObject({ trigger: "manual", jobs: null });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "records a runner that failed by its error name, with the steps that finished",
    async () => {
      await recordRun(database.db, {
        at: AT,
        trigger: "cron",
        result: { ...RESULT, jobs: null, jobsError: "TypeError" },
      });
      const [row] = await database.db.select().from(auditLog);
      expect(row.metadata).toMatchObject({
        steps: RESULT.steps.map((step) => ({ name: step.name, outcome: step.outcome })),
        jobs: { failed: true, error: "TypeError", budgetMs: RESULT.budgetMs },
      });
    },
    DB_TEST_TIMEOUT,
  );

  it("recordRun swallows a database error and logs it without the error text", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const failing = {
      insert: () => {
        throw new Error("connection refused at secret-host");
      },
    } as unknown as TestDatabase["db"];
    await expect(
      recordRun(failing, { at: AT, trigger: "cron", result: RESULT }),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret-host");
  });
});
