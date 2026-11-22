import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { account, profiles, user } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("@/lib/db/runtime", () => ({ getDb: mocks.getDb }));

import {
  ensureProfile,
  insertProfile,
  profileDisplayName,
  loadAccountSettings,
  readAccountSettings,
  saveAccountProfile,
  updateAccountProfile,
} from "./profile";

const NEW_USER = "33333333-3333-4333-8333-333333333333";

async function withUser(t: TestDatabase, email: string) {
  await t.client.query(
    `insert into "user" (id, name, email, email_verified) values ($1, '', $2, true)`,
    [NEW_USER, email],
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("profileDisplayName", () => {
  it("uses the display name, else the local part of the email", () => {
    expect(
      profileDisplayName({ email: "bu.guru@example.test", displayName: " Bu Guru " }),
    ).toBe("Bu Guru");
    expect(profileDisplayName({ email: "bu.guru@example.test", displayName: null })).toBe(
      "bu.guru",
    );
    expect(profileDisplayName({ email: "bu.guru@example.test", displayName: "  " })).toBe(
      "bu.guru",
    );
  });
});

describe("ensureProfile (PGlite, real migrations)", () => {
  it(
    "inserts the profile row for a new user through the service connection",
    async () => {
      const t = await createTestDatabase();
      mocks.getDb.mockReturnValue(t.db);
      await withUser(t, "guru@example.test");

      expect(
        await ensureProfile({
          userId: NEW_USER,
          email: "guru@example.test",
          displayName: "Bu Guru",
        }),
      ).toEqual({ ok: true });

      const rows = await t.db.select().from(profiles).where(eq(profiles.id, NEW_USER));
      expect(rows.map((row) => row.displayName)).toEqual(["Bu Guru"]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "profile row stores display name and school name",
    async () => {
      const t = await createTestDatabase();
      await withUser(t, "guru@example.test");

      await insertProfile(t.db, {
        userId: NEW_USER,
        email: "guru@example.test",
        displayName: "Bu Guru",
        schoolName: "  SMP Negeri 1 Bandung ",
      });

      const rows = await t.db.select().from(profiles).where(eq(profiles.id, NEW_USER));
      expect(rows.map((row) => [row.displayName, row.schoolName])).toEqual([
        ["Bu Guru", "SMP Negeri 1 Bandung"],
      ]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "stores no school name when none or a blank one is given",
    async () => {
      const t = await createTestDatabase();
      await withUser(t, "guru@example.test");
      await insertProfile(t.db, {
        userId: NEW_USER,
        email: "guru@example.test",
        displayName: "Bu Guru",
        schoolName: "   ",
      });
      const rows = await t.db.select().from(profiles).where(eq(profiles.id, NEW_USER));
      expect(rows.map((row) => row.schoolName)).toEqual([null]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "falls back to the email local part when the provider gave no name",
    async () => {
      const t = await createTestDatabase();
      mocks.getDb.mockReturnValue(t.db);
      await withUser(t, "pak.guru@example.test");

      await ensureProfile({
        userId: NEW_USER,
        email: "pak.guru@example.test",
        displayName: null,
      });

      const rows = await t.db.select().from(profiles).where(eq(profiles.id, NEW_USER));
      expect(rows.map((row) => row.displayName)).toEqual(["pak.guru"]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "leaves an existing profile untouched (on conflict do nothing)",
    async () => {
      const t = await createTestDatabase();
      mocks.getDb.mockReturnValue(t.db);

      expect(
        await ensureProfile({
          userId: USER_A,
          email: "a@example.test",
          displayName: "Other",
        }),
      ).toEqual({ ok: true });

      const rows = await t.db.select().from(profiles).where(eq(profiles.id, USER_A));
      expect(rows.map((row) => row.displayName)).toEqual(["Teacher A"]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "maps a database error (no such user) to generic",
    async () => {
      const t = await createTestDatabase();
      mocks.getDb.mockReturnValue(t.db);
      expect(
        await ensureProfile({
          userId: NEW_USER,
          email: "x@example.test",
          displayName: null,
        }),
      ).toEqual({ ok: false, error: "generic" });
    },
    DB_TEST_TIMEOUT,
  );

  it("maps a database that cannot be reached to generic", async () => {
    mocks.getDb.mockImplementation(() => {
      throw new Error("DATABASE_URL tidak ditemukan.");
    });
    expect(
      await ensureProfile({
        userId: NEW_USER,
        email: "x@example.test",
        displayName: null,
      }),
    ).toEqual({ ok: false, error: "generic" });
  });
});

describe("account profile (PGlite, real migrations)", () => {
  it(
    "profile update trims and saves name and school, rejects an empty name",
    async () => {
      const t = await createTestDatabase();

      expect(
        await updateAccountProfile(t.db, {
          userId: USER_A,
          name: "  Bu Sari Wulandari  ",
          schoolName: "  SMP Negeri 2 Bogor ",
        }),
      ).toEqual({ ok: true, data: undefined });
      const [saved] = await t.db
        .select({ name: user.name })
        .from(user)
        .where(eq(user.id, USER_A));
      const [profile] = await t.db.select().from(profiles).where(eq(profiles.id, USER_A));
      // The Better Auth user (the session's name) and the profile row agree.
      expect(saved.name).toBe("Bu Sari Wulandari");
      expect([profile.displayName, profile.schoolName]).toEqual([
        "Bu Sari Wulandari",
        "SMP Negeri 2 Bogor",
      ]);

      // A blank school clears it.
      await updateAccountProfile(t.db, {
        userId: USER_A,
        name: "Bu Sari",
        schoolName: " ",
      });
      const [cleared] = await t.db.select().from(profiles).where(eq(profiles.id, USER_A));
      expect(cleared.schoolName).toBeNull();

      for (const name of ["", "   ", "A", "x".repeat(81)]) {
        expect(
          await updateAccountProfile(t.db, { userId: USER_A, name, schoolName: "" }),
          JSON.stringify(name),
        ).toEqual({ ok: false, error: "invalid" });
      }
      expect(
        await updateAccountProfile(t.db, {
          userId: USER_A,
          name: "Bu Sari",
          schoolName: "s".repeat(121),
        }),
      ).toEqual({ ok: false, error: "invalid" });
      // Nothing changed by the refused updates, and the other user is untouched.
      const rows = await t.db
        .select({ id: user.id, name: user.name })
        .from(user)
        .orderBy(user.id);
      expect(rows).toEqual([
        { id: USER_A, name: "Bu Sari" },
        { id: USER_B, name: "Teacher B" },
      ]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "creates the profile row when it is missing, and answers notFound for an unknown user",
    async () => {
      const t = await createTestDatabase();
      await withUser(t, "guru@example.test");
      expect(
        await updateAccountProfile(t.db, {
          userId: NEW_USER,
          name: "Pak Budi",
          schoolName: "SMP 3",
        }),
      ).toEqual({ ok: true, data: undefined });
      const rows = await t.db.select().from(profiles).where(eq(profiles.id, NEW_USER));
      expect(rows.map((r) => [r.displayName, r.schoolName])).toEqual([
        ["Pak Budi", "SMP 3"],
      ]);

      expect(
        await updateAccountProfile(t.db, {
          userId: "44444444-4444-4444-8444-444444444444",
          name: "Pak Budi",
          schoolName: "",
        }),
      ).toEqual({ ok: false, error: "notFound" });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "reads the account settings, with hasPassword only for a credential account with a password",
    async () => {
      const t = await createTestDatabase();
      await t.db
        .update(profiles)
        .set({ schoolName: "SMP 1" })
        .where(eq(profiles.id, USER_A));
      expect(await readAccountSettings(t.db, USER_A)).toEqual({
        name: "Teacher A",
        email: "a@example.test",
        schoolName: "SMP 1",
        hasPassword: false,
      });

      await t.db.insert(account).values({
        userId: USER_A,
        providerId: "google",
        accountId: "google-sub",
        updatedAt: new Date(),
      });
      expect((await readAccountSettings(t.db, USER_A))?.hasPassword).toBe(false);

      await t.db.insert(account).values({
        userId: USER_B,
        providerId: "credential",
        accountId: USER_B,
        password: "hash",
        updatedAt: new Date(),
      });
      expect(await readAccountSettings(t.db, USER_B)).toEqual({
        name: "Teacher B",
        email: "b@example.test",
        schoolName: null,
        hasPassword: true,
      });
      expect(
        await readAccountSettings(t.db, "44444444-4444-4444-8444-444444444444"),
      ).toBeNull();
    },
    DB_TEST_TIMEOUT,
  );
});

describe("account settings on the service connection: failures are logged", () => {
  it("logs a thrown database error by operation, without the user, and answers null or generic", async () => {
    const log = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const broken = new Error('relation "profiles" does not exist');
    mocks.getDb.mockImplementation(() => {
      throw broken;
    });
    expect(await loadAccountSettings(USER_A)).toBeNull();
    expect(
      await saveAccountProfile({ userId: USER_A, name: "Bu Sari", schoolName: null }),
    ).toEqual({ ok: false, error: "generic" });
    expect(
      log.mock.calls.map(([fields]) => (fields as { operation: string }).operation),
    ).toEqual(["loadAccount", "saveProfile"]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(USER_A);
    log.mockRestore();
  });
});
