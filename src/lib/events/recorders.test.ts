import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { appErrors, auditLog, usageEvents } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import {
  AUDIT_SIGN_IN,
  AUDIT_SIGN_OUT,
  hasAudit,
  recordAudit,
  recordError,
  recordUsage,
} from "./recorders";
import { logger } from "@/lib/logger";

let database: TestDatabase;
const CORRELATION = "22222222-2222-4222-8222-222222222222";

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await database.client.close();
});

beforeEach(async () => {
  await database.db.delete(auditLog);
  await database.db.delete(usageEvents);
  await database.db.delete(appErrors);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("constants", () => {
  it("exports the known audit actions", () => {
    expect([AUDIT_SIGN_IN, AUDIT_SIGN_OUT]).toEqual(["sign_in", "sign_out"]);
  });
});

describe("recordAudit", () => {
  it("writes an audit row for the owner", async () => {
    const ok = await recordAudit(database.db, {
      ownerId: USER_A,
      action: "sign_in",
      entityType: "session",
      metadata: { method: "google" },
    });
    expect(ok).toBe(true);
    const row = (await database.db.select().from(auditLog)).at(0);
    expect(row).toMatchObject({
      ownerId: USER_A,
      action: "sign_in",
      entityType: "session",
      entityId: null,
      metadata: { method: "google" },
    });
  });

  it("defaults metadata to an empty object", async () => {
    await recordAudit(database.db, { ownerId: USER_A, action: "sign_out" });
    const row = (await database.db.select().from(auditLog)).at(0);
    expect(row?.metadata).toEqual({});
  });

  it("replaces oversize metadata with the truncation marker", async () => {
    await recordAudit(database.db, {
      ownerId: USER_A,
      action: "sign_in",
      metadata: { text: "x".repeat(5000) },
    });
    const row = (await database.db.select().from(auditLog)).at(0);
    expect(row?.metadata).toEqual({ truncated: true });
  });

  it.each(["", "ab", "Sign In", "x".repeat(65)])(
    "writes nothing and returns false for the invalid action %j",
    async (action) => {
      expect(await recordAudit(database.db, { ownerId: USER_A, action })).toBe(false);
      expect(await database.db.select().from(auditLog)).toHaveLength(0);
    },
  );

  it("returns false and does not throw when the database rejects the write", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const ok = await recordAudit(database.db, {
      ownerId: "11111111-1111-4111-8111-000000000000", // no such profile: FK violation
      action: "sign_in",
      metadata: { secret: "do-not-log-me" },
    });
    expect(ok).toBe(false);
    expect(error).toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain("do-not-log-me");
  });

  it("writes nothing and returns false when the owner id is not a uuid", async () => {
    const ok = await recordAudit(database.db, { ownerId: "e2e-user", action: "sign_in" });
    expect(ok).toBe(false);
    expect(await database.db.select().from(auditLog)).toHaveLength(0);
  });

  it("returns false instead of throwing for a null entry", async () => {
    expect(await recordAudit(database.db, null as never)).toBe(false);
  });

  it("returns false when the database object itself throws", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const broken = {
      insert: () => {
        throw new Error("boom");
      },
    } as never;
    expect(await recordAudit(broken, { ownerId: USER_A, action: "sign_in" })).toBe(false);
  });
});

describe("hasAudit", () => {
  const SESSION = "33333333-3333-4333-8333-333333333333";
  const key = {
    ownerId: USER_A,
    action: "sign_in",
    entityType: "session",
    entityId: SESSION,
  };

  it("finds a row for the same owner, action and entity only", async () => {
    expect(await hasAudit(database.db, key)).toBe(false);
    await recordAudit(database.db, key);
    expect(await hasAudit(database.db, key)).toBe(true);
    expect(await hasAudit(database.db, { ...key, action: "sign_out" })).toBe(false);
    expect(
      await hasAudit(database.db, {
        ...key,
        entityId: "44444444-4444-4444-8444-444444444444",
      }),
    ).toBe(false);
    expect(await hasAudit(database.db, { ...key, ownerId: USER_B })).toBe(false);
  });

  it("answers false for an entry without a valid entity", async () => {
    expect(await hasAudit(database.db, { ...key, entityId: "not-a-uuid" })).toBe(false);
  });
});

describe("recordUsage", () => {
  it("writes a usage row", async () => {
    const ok = await recordUsage(database.db, {
      ownerId: USER_A,
      event: "batch_generated",
      entityType: "generation_request",
      durationMs: 1234,
      metadata: { questions: 5 },
    });
    expect(ok).toBe(true);
    const row = (await database.db.select().from(usageEvents)).at(0);
    expect(row).toMatchObject({
      ownerId: USER_A,
      event: "batch_generated",
      entityType: "generation_request",
      durationMs: 1234,
      metadata: { questions: 5 },
    });
  });

  it("rejects an invalid event name and a negative or non-integer duration", async () => {
    expect(await recordUsage(database.db, { ownerId: USER_A, event: "Nope" })).toBe(
      false,
    );
    expect(
      await recordUsage(database.db, {
        ownerId: USER_A,
        event: "task_done",
        durationMs: -1,
      }),
    ).toBe(false);
    expect(
      await recordUsage(database.db, {
        ownerId: USER_A,
        event: "task_done",
        durationMs: 1.5,
      }),
    ).toBe(false);
    expect(await database.db.select().from(usageEvents)).toHaveLength(0);
  });
});

describe("recordUsage owner and entry validation", () => {
  it("writes nothing and returns false when the owner id is not a uuid", async () => {
    const ok = await recordUsage(database.db, {
      ownerId: "e2e-user",
      event: "task_done",
    });
    expect(ok).toBe(false);
    expect(await database.db.select().from(usageEvents)).toHaveLength(0);
  });

  it("returns false instead of throwing for a null entry", async () => {
    expect(await recordUsage(database.db, null as never)).toBe(false);
  });
});

describe("recordError", () => {
  it("writes an error with an owner and a correlation id", async () => {
    const ok = await recordError(database.db, {
      ownerId: USER_A,
      correlationId: CORRELATION,
      source: "job:generate_batch",
      code: "provider_error",
      message: "The provider returned 500.",
      context: { jobId: "abc" },
    });
    expect(ok).toBe(true);
    const row = (await database.db.select().from(appErrors)).at(0);
    expect(row).toMatchObject({
      ownerId: USER_A,
      correlationId: CORRELATION,
      source: "job:generate_batch",
      code: "provider_error",
      message: "The provider returned 500.",
      context: { jobId: "abc" },
    });
  });

  it("allows an error with no owner and no correlation id", async () => {
    expect(await recordError(database.db, { source: "web", message: "oops" })).toBe(true);
    const row = (await database.db.select().from(appErrors)).at(0);
    expect(row).toMatchObject({ ownerId: null, correlationId: null, code: null });
  });

  it("drops an invalid correlation id instead of failing the write", async () => {
    expect(
      await recordError(database.db, {
        source: "web",
        message: "oops",
        correlationId: "not-a-uuid",
      }),
    ).toBe(true);
    const row = (await database.db.select().from(appErrors)).at(0);
    expect(row?.correlationId).toBeNull();
  });

  it("truncates the message by code point without splitting a surrogate pair", async () => {
    const message = `${"a".repeat(499)}😀${"b".repeat(50)}`;
    expect(await recordError(database.db, { source: "web", message })).toBe(true);
    const [row] = await database.db.select().from(appErrors);
    expect(Array.from(row.message)).toHaveLength(500);
    expect(row.message.isWellFormed()).toBe(true);
  });

  it("truncates a long code to 64 code points", async () => {
    await recordError(database.db, {
      source: "web",
      message: "m",
      code: "c".repeat(200),
    });
    const row = (await database.db.select().from(appErrors)).at(0);
    expect(row?.code).toHaveLength(64);
  });

  it("rejects an invalid source name", async () => {
    expect(await recordError(database.db, { source: "Bad Source", message: "m" })).toBe(
      false,
    );
    expect(await database.db.select().from(appErrors)).toHaveLength(0);
  });

  it("keeps rows of an anonymised owner when the profile is later removed", async () => {
    await recordError(database.db, { ownerId: USER_A, source: "web", message: "m" });
    await database.db.execute(
      // the harness base connection is the table owner and bypasses RLS
      `delete from "user" where id = '${USER_A}'` as never,
    );
    const rows = await database.db
      .select()
      .from(appErrors)
      .where(eq(appErrors.source, "web"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ownerId).toBeNull();
  });
});
