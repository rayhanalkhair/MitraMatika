import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  account as accountTable,
  session as sessionTable,
  user as userTable,
} from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { prepareGoogleLink } from "./link-guard";

const DAY = 86_400_000;

async function userWith(
  t: TestDatabase,
  email: string,
  emailVerified: boolean,
): Promise<string> {
  const [row] = await t.db
    .insert(userTable)
    .values({ name: "Guru", email, emailVerified })
    .returning();
  await t.db.insert(accountTable).values({
    userId: row.id,
    providerId: "credential",
    accountId: row.id,
    password: "hash",
    updatedAt: new Date(),
  });
  for (const token of [`${email}-1`, `${email}-2`]) {
    await t.db.insert(sessionTable).values({
      userId: row.id,
      token,
      expiresAt: new Date(Date.now() + DAY),
      updatedAt: new Date(),
    });
  }
  return row.id;
}

const accountsOf = (t: TestDatabase, userId: string) =>
  t.db.select().from(accountTable).where(eq(accountTable.userId, userId));
const sessionsOf = (t: TestDatabase, userId: string) =>
  t.db.select().from(sessionTable).where(eq(sessionTable.userId, userId));
const verifiedOf = async (t: TestDatabase, userId: string) =>
  (await t.db.select().from(userTable).where(eq(userTable.id, userId)))[0]?.emailVerified;

describe("prepareGoogleLink", () => {
  it(
    "deletes every account and session of an unverified user and marks the email verified",
    async () => {
      const t = await createTestDatabase();
      const squatted = await userWith(t, "korban@example.test", false);
      const other = await userWith(t, "lain@example.test", false);

      await prepareGoogleLink(t.db, { userId: squatted });

      expect(await accountsOf(t, squatted)).toEqual([]);
      expect(await sessionsOf(t, squatted)).toEqual([]);
      expect(await verifiedOf(t, squatted)).toBe(true);
      // Nobody else is touched.
      expect(await accountsOf(t, other)).toHaveLength(1);
      expect(await sessionsOf(t, other)).toHaveLength(2);
      expect(await verifiedOf(t, other)).toBe(false);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "leaves a verified user exactly as it is",
    async () => {
      const t = await createTestDatabase();
      const verified = await userWith(t, "guru@example.test", true);

      await prepareGoogleLink(t.db, { userId: verified });

      expect(await accountsOf(t, verified)).toHaveLength(1);
      expect(await sessionsOf(t, verified)).toHaveLength(2);
      expect(await verifiedOf(t, verified)).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "does nothing for an unknown user",
    async () => {
      const t = await createTestDatabase();
      const before = await t.db.select().from(userTable);
      await prepareGoogleLink(t.db, { userId: "33333333-3333-3333-3333-333333333333" });
      expect(await t.db.select().from(userTable)).toEqual(before);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "changes nothing when a step fails: the deletions and the verification are one transaction",
    async () => {
      const t = await createTestDatabase();
      const squatted = await userWith(t, "korban@example.test", false);
      // Make the last write fail: sessions of this user cannot be deleted.
      await t.client.exec(`
        create function refuse_session_delete() returns trigger language plpgsql as $$
        begin raise exception 'refused'; end $$;
        create trigger refuse_session_delete before delete on "session"
          for each row execute function refuse_session_delete();
      `);

      await expect(prepareGoogleLink(t.db, { userId: squatted })).rejects.toThrow();

      expect(await accountsOf(t, squatted)).toHaveLength(1);
      expect(await sessionsOf(t, squatted)).toHaveLength(2);
      expect(await verifiedOf(t, squatted)).toBe(false);
    },
    DB_TEST_TIMEOUT,
  );
});
