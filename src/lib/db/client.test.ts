import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { checkDbConnection, runAsUser } from "./client";
import { profiles } from "./schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "./test-harness";

describe("runAsUser", () => {
  let active: TestDatabase | undefined;

  afterEach(async () => {
    await active?.client.close();
    active = undefined;
  });

  it(
    "only exposes the calling user's own row under RLS",
    async () => {
      active = await createTestDatabase();

      const rows = await runAsUser(active.db, USER_A, async (tx) =>
        tx.select().from(profiles),
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(USER_A);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "exposes a different single row for a different user",
    async () => {
      active = await createTestDatabase();

      const rows = await runAsUser(active.db, USER_B, async (tx) =>
        tx.select().from(profiles),
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(USER_B);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "restricts rows only inside runAsUser, and the role/claim setting does not leak outside its transaction",
    async () => {
      active = await createTestDatabase();
      const { db } = active;

      const scopedRows = await runAsUser(db, USER_A, async (tx) =>
        tx.select().from(profiles),
      );
      expect(scopedRows).toHaveLength(1);
      expect(scopedRows[0]?.id).toBe(USER_A);

      // The base connection is the table owner and bypasses RLS (the service path), so it
      // still sees both rows. If `set local role authenticated` were ever removed from
      // runAsUser, the scoped query above would also see both rows and fail.
      const unscopedRows = await db.select().from(profiles);
      expect(unscopedRows).toHaveLength(2);

      const roleResult = await db.execute<{ current_role: string }>(
        sql`select current_role`,
      );
      expect(roleResult.rows[0]?.current_role).toBe("postgres");

      const claimResult = await db.execute<{ claim: string | null }>(
        sql`select current_setting('request.jwt.claim.sub', true) as claim`,
      );
      expect(claimResult.rows[0]?.claim).toBeFalsy();
    },
    DB_TEST_TIMEOUT,
  );
});

describe("checkDbConnection", () => {
  it("returns a failure result rather than throwing when the target is unreachable", async () => {
    // Port 1 on localhost refuses connections immediately, so this exercises the
    // catch/return path without contacting any real service.
    const result = await checkDbConnection(
      "postgresql://baduser:badpass@127.0.0.1:1/nonexistent",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});
