import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verification } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { LIMIT_ROW_PREFIXES, pruneExpiredLimitRows } from "./prune-limit-rows";

const NOW = new Date("2026-11-18T03:00:00.000Z");
const HOUR = 60 * 60 * 1000;

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await t.client.close();
});

describe("pruneExpiredLimitRows", () => {
  it(
    "deletes the app's limit rows expired over a day ago and nothing else",
    async () => {
      const at = (offsetHours: number) => new Date(NOW.getTime() + offsetHours * HOUR);
      await t.db.insert(verification).values([
        ...LIMIT_ROW_PREFIXES.map((prefix) => ({
          identifier: `${prefix}old`,
          value: "1",
          expiresAt: at(-25),
        })),
        { identifier: "email-sent:recent", value: "1", expiresAt: at(-23) },
        { identifier: "sign-in-failure:live", value: "1", expiresAt: at(1) },
        // Better Auth's own rows: a reset token (hashed identifier) and an address row.
        { identifier: "a1b2c3", value: "user-id", expiresAt: at(-48) },
        { identifier: "guru@example.test", value: "x", expiresAt: at(-48) },
      ]);

      expect(await pruneExpiredLimitRows(t.db, NOW)).toBe(LIMIT_ROW_PREFIXES.length);

      const left = (await t.db.select().from(verification))
        .map((r) => r.identifier)
        .sort();
      expect(left).toEqual(
        [
          "a1b2c3",
          "email-sent:recent",
          "guru@example.test",
          "sign-in-failure:live",
        ].sort(),
      );
    },
    DB_TEST_TIMEOUT,
  );
});
