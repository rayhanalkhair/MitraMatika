import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { jobs } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { isJobDue, isUuid, readJobStatus, readJobStatusAndDue } from "./status";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await database.client.close();
});

beforeEach(async () => {
  await database.db.delete(jobs);
});

const insertJob = async (ownerId: string, overrides: Record<string, unknown> = {}) => {
  const [row] = await database.db
    .insert(jobs)
    .values({
      ownerId,
      type: "generate_batch",
      payload: { secretPrompt: "do-not-leak" },
      ...overrides,
    })
    .returning();
  return row;
};

describe("isUuid", () => {
  it("accepts uuids and rejects everything else", () => {
    expect(isUuid("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(isUuid("nope")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid("11111111-1111-4111-8111-11111111111")).toBe(false);
  });
});

describe("readJobStatus", () => {
  it("returns the whitelisted shape for the owner's own job", async () => {
    const job = await insertJob(USER_A, {
      status: "deferred",
      progress: { step: "quota", done: 1, total: 3, messageKey: "quota_wait" },
      error: { code: "provider_error", message: "internal detail" },
      attempts: 2,
    });
    const status = await readJobStatus(database.db, USER_A, job.id);
    expect(status).toEqual({
      id: job.id,
      type: "generate_batch",
      status: "deferred",
      progress: { step: "quota", done: 1, total: 3, messageKey: "quota_wait" },
      error: { code: "provider_error" },
      runAfter: job.runAfter.toISOString(),
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    });
    const text = JSON.stringify(status);
    for (const hidden of [
      "do-not-leak",
      "internal detail",
      "lockToken",
      "attempts",
      "correlation",
    ]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("returns null for a job that does not exist", async () => {
    expect(
      await readJobStatus(database.db, USER_A, "00000000-0000-4000-8000-000000000000"),
    ).toBeNull();
  });

  it("returns null when the job belongs to another teacher (enforced by RLS)", async () => {
    const theirs = await insertJob(USER_B);
    expect(await readJobStatus(database.db, USER_A, theirs.id)).toBeNull();
    expect(await readJobStatus(database.db, USER_B, theirs.id)).not.toBeNull();
  });

  it("maps a job without error or progress to nulls", async () => {
    const job = await insertJob(USER_A);
    expect(await readJobStatus(database.db, USER_A, job.id)).toMatchObject({
      status: "queued",
      progress: null,
      error: null,
    });
  });
});

describe("job due rules (kick on poll)", () => {
  const NOW = new Date("2026-11-16T12:00:00.000Z");
  const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
  const dueOf = async (
    ownerId: string,
    overrides: Record<string, unknown>,
    reader = USER_A,
  ) => {
    const job = await insertJob(ownerId, overrides);
    return (await readJobStatusAndDue(database.db, reader, job.id, () => NOW))?.due;
  };

  it.each([
    ["deferred past run_after", { status: "deferred", runAfter: at(-1_000) }, true],
    ["deferred before run_after", { status: "deferred", runAfter: at(60_000) }, false],
    ["queued and due", { status: "queued", runAfter: at(-1) }, true],
    ["queued in the future", { status: "queued", runAfter: at(5_000) }, false],
    ["running with a fresh lease", { status: "running", lockedAt: at(-60_000) }, false],
    [
      "running with an expired lease",
      { status: "running", lockedAt: at(-601_000) },
      true,
    ],
    ["succeeded", { status: "succeeded", runAfter: at(-1_000) }, false],
    ["failed", { status: "failed", runAfter: at(-1_000) }, false],
    ["cancelled", { status: "cancelled", runAfter: at(-1_000) }, false],
  ])("%s", async (_name, overrides, expected) => {
    expect(await dueOf(USER_A, overrides)).toBe(expected);
  });

  it("does not see another teacher job at all", async () => {
    expect(
      await dueOf(USER_B, { status: "deferred", runAfter: at(-1_000) }),
    ).toBeUndefined();
  });

  it("isJobDue treats a running job without a lock time as not due", () => {
    expect(isJobDue({ status: "running", runAfter: at(-1), lockedAt: null }, NOW)).toBe(
      false,
    );
  });
});
