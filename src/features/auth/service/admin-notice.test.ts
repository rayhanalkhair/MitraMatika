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
import { profiles, user as userTable, verification } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { createFakeEmailSender, type FakeEmailSender } from "@/lib/email/fake";
import { logger } from "@/lib/logger";
import {
  claimNotice,
  createAdminNotifier,
  DIGEST_MAX_ACCOUNTS,
  releaseNotice,
  sanitizeLine,
} from "./admin-notice";
import {
  AUTH_EMAILS_PER_DAY,
  createGlobalSendBudget,
  RESET_EMAIL_RESERVE,
} from "./global-send-budget";

// PGlite with the real migrations, a fake sender and a fixed clock. "Approved" is the admin's own
// address (ADMIN_EMAIL, read through the environment) or an injected predicate, so no test names
// the approval list variable.
const ADMIN = "admin@example.test";
const NOW = new Date("2026-11-22T07:00:00.000Z"); // 14:00 in Jakarta

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await t.client.close();
});

let logs: string[];
beforeEach(async () => {
  await t.db.delete(userTable);
  await t.db.delete(verification);
  vi.stubEnv("ADMIN_EMAIL", ADMIN);
  logs = [];
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      logs.push(JSON.stringify(args));
    });
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

let counter = 0;
async function newUser(
  overrides: {
    email?: string;
    name?: string;
    verified?: boolean;
    school?: string | null;
  } = {},
) {
  counter += 1;
  const email = overrides.email ?? `guru${String(counter)}@example.test`;
  const [row] = await t.db
    .insert(userTable)
    .values({
      name: overrides.name ?? `Guru ${String(counter)}`,
      email,
      emailVerified: overrides.verified ?? true,
      createdAt: new Date(NOW.getTime() + counter),
    })
    .returning({ id: userTable.id });
  if (overrides.school !== undefined) {
    await t.db.insert(profiles).values({
      id: row.id,
      displayName: overrides.name ?? null,
      schoolName: overrides.school,
    });
  }
  return { id: row.id, email };
}

const notifiedAt = async (id: string) =>
  (await t.db.select().from(profiles).where(eq(profiles.id, id)))[0]?.adminNotifiedAt;

function notifier(
  options: { fake?: FakeEmailSender; isApproved?: (e: string) => boolean } = {},
) {
  const fake = options.fake ?? createFakeEmailSender();
  return {
    fake,
    ...createAdminNotifier({
      db: t.db,
      getSender: () => fake.send,
      now: () => NOW,
      ...(options.isApproved ? { isApproved: options.isApproved } : {}),
    }),
  };
}

describe("sanitizeLine", () => {
  it("removes controls and newlines, collapses spaces and cuts by characters", () => {
    expect(sanitizeLine("A\nB\u0000C\u0085D\r\nE", 80)).toBe("A B C D E");
    expect(sanitizeLine("  a \t\t b  ", 80)).toBe("a b");
    expect(sanitizeLine("x​z‮y", 80)).toBe("x z y");
    expect(sanitizeLine("a".repeat(200), 80)).toHaveLength(80);
    expect(sanitizeLine("😀".repeat(10), 3)).toBe("😀😀😀");
  });
});

describe("claimNotice", () => {
  it(
    "two concurrent claims for one user return exactly one non-null",
    async () => {
      const u = await newUser();
      const results = await Promise.all([
        claimNotice(t.db, u.id, { isApproved: () => false }),
        claimNotice(t.db, u.id, { isApproved: () => false }),
        claimNotice(t.db, u.id, { isApproved: () => false }),
      ]);
      expect(results.filter((r) => r !== null)).toHaveLength(1);
      expect(await notifiedAt(u.id)).toBeInstanceOf(Date);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "claims an approved account without returning a notice",
    async () => {
      const u = await newUser();
      expect(await claimNotice(t.db, u.id, { isApproved: () => true })).toBeNull();
      expect(await notifiedAt(u.id)).toBeInstanceOf(Date);
      expect(await claimNotice(t.db, u.id, { isApproved: () => false })).toBeNull();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "never claims an unverified account (and writes no profile for it)",
    async () => {
      const u = await newUser({ verified: false });
      expect(await claimNotice(t.db, u.id, { isApproved: () => false })).toBeNull();
      expect(await t.db.select().from(profiles).where(eq(profiles.id, u.id))).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "creates the profile row when it is missing, and returns the school",
    async () => {
      const a = await newUser({ name: "Bu Ani" });
      const claimedA = await claimNotice(t.db, a.id, { isApproved: () => false });
      expect(claimedA).toMatchObject({
        name: "Bu Ani",
        schoolName: null,
        email: a.email,
      });
      const b = await newUser({ name: "Pak Budi", school: "SMP 1" });
      expect(await claimNotice(t.db, b.id, { isApproved: () => false })).toMatchObject({
        schoolName: "SMP 1",
      });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "release gives the claim back",
    async () => {
      const u = await newUser();
      await claimNotice(t.db, u.id, { isApproved: () => false });
      await releaseNotice(t.db, u.id);
      expect(await notifiedAt(u.id)).toBeNull();
      expect(await claimNotice(t.db, u.id, { isApproved: () => false })).not.toBeNull();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "returns null for an unknown user",
    async () => {
      expect(
        await claimNotice(t.db, "33333333-3333-3333-3333-333333333333", {
          isApproved: () => false,
        }),
      ).toBeNull();
    },
    DB_TEST_TIMEOUT,
  );
});

describe("notify", () => {
  it(
    "sends one email to the admin with the account details and how to approve",
    async () => {
      const u = await newUser({ name: "Bu Sari", school: "SDN 3 Contoh" });
      const n = notifier();
      await n.notify(u.id);
      expect(n.fake.messages).toHaveLength(1);
      const [message] = n.fake.messages;
      expect(message.to).toBe(ADMIN);
      expect(message.subject).toBe("Akun baru menunggu persetujuan di MitraMatika");
      expect(message.text).toContain(u.email);
      expect(message.text).toContain("Bu Sari");
      expect(message.text).toContain("SDN 3 Contoh");
      expect(message.text).toMatch(/22 November 2026.*14[.:]00 WIB/);
      expect(message.text).toMatch(/Vercel/);
      expect(message.text).toMatch(/redeploy/);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "shows - for an empty school",
    async () => {
      const u = await newUser();
      const n = notifier();
      await n.notify(u.id);
      expect(n.fake.messages[0].text).toContain("Sekolah: -");
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "verification clicked twice (two triggers) sends one email",
    async () => {
      const u = await newUser();
      const n = notifier();
      await Promise.all([n.notify(u.id), n.notify(u.id)]);
      await n.notify(u.id);
      expect(n.fake.messages).toHaveLength(1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "sends nothing for an approved account, and nothing for an unverified one",
    async () => {
      const a = await newUser();
      const b = await newUser({ verified: false });
      const n = notifier({ isApproved: (email) => email === a.email });
      await n.notify(a.id);
      await n.notify(b.id);
      expect(n.fake.messages).toEqual([]);
      expect(await notifiedAt(a.id)).toBeInstanceOf(Date);
      expect(await notifiedAt(b.id)).toBeUndefined();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "the admin's own account is approved and gets no notice",
    async () => {
      const admin = await newUser({ email: ADMIN });
      const n = notifier();
      await n.notify(admin.id);
      expect(n.fake.messages).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a failed send gives the claim and the budget slot back",
    async () => {
      const u = await newUser();
      const bad = notifier({ fake: createFakeEmailSender({ fail: "resend_down" }) });
      await bad.notify(u.id);
      expect(await notifiedAt(u.id)).toBeNull();
      const rows = await t.db.select().from(verification);
      expect(rows).toEqual([]);
      // The next trigger (or the digest) can still send it.
      const good = notifier();
      await good.notify(u.id);
      expect(good.fake.messages).toHaveLength(1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a throwing sender is contained: no rejection, claim released",
    async () => {
      const u = await newUser();
      const n = createAdminNotifier({
        db: t.db,
        now: () => NOW,
        getSender: () => () => Promise.reject(new Error("boom with " + u.email)),
      });
      await expect(n.notify(u.id)).resolves.toBeUndefined();
      expect(await notifiedAt(u.id)).toBeNull();
      expect(logs.join("\n")).not.toContain(u.email);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "ADMIN_EMAIL unset: nothing is sent and nothing is claimed",
    async () => {
      vi.stubEnv("ADMIN_EMAIL", "");
      const u = await newUser();
      const n = notifier();
      await n.notify(u.id);
      expect(n.fake.messages).toEqual([]);
      expect(await notifiedAt(u.id)).toBeUndefined();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "the address comes only from ADMIN_EMAIL, trimmed",
    async () => {
      vi.stubEnv("ADMIN_EMAIL", "  Boss@Example.test ");
      const u = await newUser();
      const n = notifier();
      await n.notify(u.id);
      expect(n.fake.messages[0].to).toBe("Boss@Example.test");
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "cleans a name with a newline and a control character and cuts it to 80 characters",
    async () => {
      const u = await newUser({ name: "Evil\nBcc: x@y.test\u0007" + "n".repeat(200) });
      const n = notifier();
      await n.notify(u.id);
      const text = n.fake.messages[0].text;
      expect(text).not.toContain("\u0007");
      const nameLine = text.split("\n").find((line) => line.startsWith("Nama: ")) ?? "";
      expect(nameLine.slice("Nama: ".length)).toHaveLength(80);
      expect(text.split("\n").some((line) => line.startsWith("Bcc:"))).toBe(false);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "logs carry neither the address nor the name",
    async () => {
      const ok = await newUser({
        email: "rahasia.guru@example.test",
        name: "Bu Rahasia",
      });
      await notifier().notify(ok.id);
      const refused = await newUser({
        email: "lain.guru@example.test",
        name: "Pak Lain",
      });
      await notifier({ fake: createFakeEmailSender({ fail: "boom" }) }).notify(
        refused.id,
      );
      await notifier().digest();
      const all = logs.join("\n");
      expect(all).not.toContain("rahasia.guru");
      expect(all).not.toContain("Bu Rahasia");
      expect(all).not.toContain("lain.guru");
      expect(all).not.toContain("Pak Lain");
      expect(all).not.toContain(ADMIN);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("the budget", () => {
  it(
    "a flood of 30 verified accounts: 10 notices, claims of the rest released, one digest, resets still go",
    async () => {
      const users = [];
      for (let i = 0; i < 30; i += 1) users.push(await newUser());
      const n = notifier();
      for (const u of users) await n.notify(u.id);
      expect(n.fake.messages).toHaveLength(10);
      let unclaimed = 0;
      for (const u of users) if ((await notifiedAt(u.id)) === null) unclaimed += 1;
      expect(unclaimed).toBe(20);
      // The digest (the 11th use of the admin sub-budget) lists the other twenty.
      const report = await n.digest();
      expect(report).toEqual({});
      expect(n.fake.messages).toHaveLength(11);
      expect(
        n.fake.messages[10].text.split("\n").filter((l) => l.startsWith("- ")),
      ).toHaveLength(20);
      // The admin's 11 emails used 11 of the 60 slots of ordinary emails; the reset reserve is whole.
      const budget = createGlobalSendBudget(t.db, () => NOW);
      let verifies = 0;
      for (let i = 0; i < 80; i += 1) {
        if ((await budget.reserve("verify")) !== null) verifies += 1;
      }
      expect(verifies).toBe(AUTH_EMAILS_PER_DAY - RESET_EMAIL_RESERVE - 11);
      let resets = 0;
      for (let i = 0; i < 30; i += 1) {
        if ((await budget.reserve("reset")) !== null) resets += 1;
      }
      expect(resets).toBe(RESET_EMAIL_RESERVE);
    },
    DB_TEST_TIMEOUT * 4,
  );

  it(
    "a refused notice leaves its slot and no row behind, and the account waits for the digest",
    async () => {
      const budget = createGlobalSendBudget(t.db, () => NOW);
      // Verification emails fill the app-wide 60.
      for (let i = 0; i < AUTH_EMAILS_PER_DAY - RESET_EMAIL_RESERVE; i += 1) {
        await budget.reserve("verify");
      }
      const before = (await t.db.select().from(verification)).length;
      const u = await newUser();
      const n = notifier();
      await n.notify(u.id);
      expect(n.fake.messages).toEqual([]);
      expect(await notifiedAt(u.id)).toBeNull();
      expect((await t.db.select().from(verification)).length).toBe(before);
      await n.digest();
      expect(n.fake.messages).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("digest", () => {
  it(
    "30 waiting accounts: one email with 25, the next call sends the other 5",
    async () => {
      for (let i = 0; i < 30; i += 1) await newUser();
      const n = notifier();
      const first = await n.digest();
      expect(first).toEqual({ backlogLeft: true });
      expect(n.fake.messages).toHaveLength(1);
      expect(n.fake.messages[0].to).toBe(ADMIN);
      const lines = (m: string) => m.split("\n").filter((l) => l.startsWith("- "));
      expect(lines(n.fake.messages[0].text)).toHaveLength(DIGEST_MAX_ACCOUNTS);
      await n.digest();
      expect(n.fake.messages).toHaveLength(2);
      expect(lines(n.fake.messages[1].text)).toHaveLength(5);
      await n.digest();
      expect(n.fake.messages).toHaveLength(2);
    },
    DB_TEST_TIMEOUT * 2,
  );

  it(
    "sends nothing when nobody is waiting, and skips unverified and approved accounts",
    async () => {
      const n0 = notifier();
      expect(await n0.digest()).toEqual({});
      expect(n0.fake.messages).toEqual([]);
      const approved = await newUser();
      await newUser({ verified: false });
      const n = notifier({ isApproved: (email) => email === approved.email });
      await n.digest();
      expect(n.fake.messages).toEqual([]);
      // The approved account was claimed silently.
      expect(await notifiedAt(approved.id)).toBeInstanceOf(Date);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a send failure releases every claim and reports failed",
    async () => {
      const users = [];
      for (let i = 0; i < 3; i += 1) users.push(await newUser());
      const n = notifier({ fake: createFakeEmailSender({ fail: "down" }) });
      expect(await n.digest()).toEqual({ failed: true });
      for (const u of users) expect(await notifiedAt(u.id)).toBeNull();
      expect(await t.db.select().from(verification)).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "ADMIN_EMAIL unset: one warn, nothing claimed or sent",
    async () => {
      vi.stubEnv("ADMIN_EMAIL", "");
      const u = await newUser();
      const n = notifier();
      await n.digest();
      expect(n.fake.messages).toEqual([]);
      expect(await notifiedAt(u.id)).toBeUndefined();
      expect(logs.filter((l) => l.includes("no admin address"))).toHaveLength(1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "does not list an account a single notice already claimed",
    async () => {
      const a = await newUser();
      await newUser();
      const n = notifier();
      await n.notify(a.id);
      await n.digest();
      expect(n.fake.messages).toHaveLength(2);
      expect(n.fake.messages[1].text).not.toContain(a.email);
    },
    DB_TEST_TIMEOUT,
  );
});
