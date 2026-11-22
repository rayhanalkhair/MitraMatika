import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { account, profiles, session, user, verification } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  type TestDatabase,
} from "@/lib/db/test-harness";
import {
  PRUNE_BATCH_SIZE,
  pruneUnverifiedUsers,
  UNVERIFIED_ACCOUNT_MAX_AGE_DAYS,
} from "./prune-unverified";

const NOW = new Date("2026-11-18T03:00:00.000Z");
const DAY = 86_400_000;

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await t.client.close();
});
beforeEach(async () => {
  await t.db.delete(verification);
  await t.db.execute(sql`delete from "user"`);
});

async function seedUser(
  email: string,
  verified: boolean,
  ageDays: number,
  { withSession = verified, withGoogle = false } = {},
) {
  const createdAt = new Date(NOW.getTime() - ageDays * DAY);
  const [row] = await t.db
    .insert(user)
    .values({
      name: "Guru",
      email,
      emailVerified: verified,
      createdAt,
      updatedAt: createdAt,
    })
    .returning({ id: user.id });
  await t.db.insert(account).values({
    userId: row.id,
    providerId: "credential",
    accountId: row.id,
    password: "hash",
    updatedAt: createdAt,
  });
  if (withGoogle) {
    await t.db.insert(account).values({
      userId: row.id,
      providerId: "google",
      accountId: `google-${email}`,
      updatedAt: createdAt,
    });
  }
  if (withSession) {
    await t.db.insert(session).values({
      userId: row.id,
      token: `token-${email}`,
      expiresAt: new Date(NOW.getTime() + DAY),
      updatedAt: createdAt,
    });
  }
  await t.db.insert(profiles).values({ id: row.id, displayName: "Guru" });
  await t.db.insert(verification).values([
    { identifier: email, value: "x", expiresAt: new Date(NOW.getTime() + DAY) },
    {
      identifier: `hashed-${email}`,
      value: row.id,
      expiresAt: new Date(NOW.getTime() + DAY),
    },
    {
      identifier: `state-${email}`,
      value: JSON.stringify({ link: { userId: row.id } }),
      expiresAt: new Date(NOW.getTime() + DAY),
    },
  ]);
  return row.id;
}

const rowsOf = async (id: string) => ({
  user: await t.db.select().from(user).where(eq(user.id, id)),
  account: await t.db.select().from(account).where(eq(account.userId, id)),
  session: await t.db.select().from(session).where(eq(session.userId, id)),
  profile: await t.db.select().from(profiles).where(eq(profiles.id, id)),
});

describe("pruneUnverifiedUsers", () => {
  it("keeps unverified users for 7 days", () => {
    expect(UNVERIFIED_ACCOUNT_MAX_AGE_DAYS).toBe(7);
  });

  it(
    "deletes unverified users older than 7 days with their account, profile and verification rows, and nothing else",
    async () => {
      const stale = await seedUser("lama@example.test", false, 8);
      const fresh = await seedUser("baru@example.test", false, 6);
      const verifiedOld = await seedUser("guru@example.test", true, 30);

      expect(await pruneUnverifiedUsers(t.db, NOW)).toBe(1);

      expect(await rowsOf(stale)).toEqual({
        user: [],
        account: [],
        session: [],
        profile: [],
      });
      for (const kept of [fresh, verifiedOld]) {
        const rows = await rowsOf(kept);
        expect(rows.user).toHaveLength(1);
        expect(rows.account).toHaveLength(1);
        expect(rows.profile).toHaveLength(1);
      }
      expect((await rowsOf(verifiedOld)).session).toHaveLength(1);
      const identifiers = (await t.db.select().from(verification)).map(
        (r) => r.identifier,
      );
      expect(identifiers.filter((id) => id.includes("lama@"))).toEqual([]);
      expect(identifiers.filter((id) => id.includes("baru@"))).toHaveLength(3);
      expect(identifiers.filter((id) => id.includes("guru@"))).toHaveLength(3);
      // The address is free again; a second run has nothing to do.
      expect(await pruneUnverifiedUsers(t.db, NOW)).toBe(0);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "never deletes a verified user, however old",
    async () => {
      const id = await seedUser("guru@example.test", true, 365);
      expect(await pruneUnverifiedUsers(t.db, new Date(NOW.getTime() + 365 * DAY))).toBe(
        0,
      );
      expect((await rowsOf(id)).user).toHaveLength(1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "skips an old unverified user who has a session or a Google account",
    async () => {
      const withSession = await seedUser("sesi@example.test", false, 30, {
        withSession: true,
      });
      const withGoogle = await seedUser("google@example.test", false, 30, {
        withGoogle: true,
      });
      expect(await pruneUnverifiedUsers(t.db, NOW)).toBe(0);
      expect((await rowsOf(withSession)).user).toHaveLength(1);
      expect((await rowsOf(withGoogle)).user).toHaveLength(1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "deletes at most a batch per run, oldest first",
    async () => {
      expect(PRUNE_BATCH_SIZE).toBe(500);
      const oldest = await seedUser("a@example.test", false, 30);
      const middle = await seedUser("b@example.test", false, 20);
      const newest = await seedUser("c@example.test", false, 10);
      expect(await pruneUnverifiedUsers(t.db, NOW, { limit: 2 })).toBe(2);
      expect((await rowsOf(oldest)).user).toEqual([]);
      expect((await rowsOf(middle)).user).toEqual([]);
      expect((await rowsOf(newest)).user).toHaveLength(1);
      expect(await pruneUnverifiedUsers(t.db, NOW, { limit: 2 })).toBe(1);
    },
    DB_TEST_TIMEOUT,
  );
});
