import { eq, like, sql } from "drizzle-orm";
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
import { verification } from "@/lib/db/schema";
import { FIXTURE, seedFixtures } from "@/lib/db/test-fixtures";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { createFakeEmailSender, type FakeEmailSender } from "@/lib/email/fake";
import { logger } from "@/lib/logger";
import { recordLocks } from "@/lib/storage/lock-recorder";
import {
  APP_STORAGE_CAP_BYTES,
  type AppStorageUsage,
  type AppTotalDb,
} from "@/lib/storage/app-total";
import {
  ADMIN_NOTICES_PER_DAY,
  AUTH_EMAILS_PER_DAY,
  createGlobalSendBudget,
  RESET_EMAIL_RESERVE,
} from "./global-send-budget";
import { createStorageAlerter, STORAGE_ALERT_LEVELS } from "./storage-alert";

// PGlite with the real migrations, a fake sender, a fake clock and an injected total (the real
// total is covered by app-total.test.ts; one test below runs the default wiring on real rows).
const ADMIN = "admin@example.test";
const TEACHER = "guru.rahasia@example.test";
const NOW = new Date("2026-11-22T07:00:00.000Z"); // 14:00 in Jakarta
const DAY = 24 * 60 * 60 * 1000;
const CAP = APP_STORAGE_CAP_BYTES;
const MB = 1024 * 1024;

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await t.client.close();
});

let logs: string[];
beforeEach(async () => {
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

const usageOf = (usedBytes: number): AppStorageUsage => ({
  usedBytes,
  capBytes: CAP,
  parts: { materials: usedBytes, pages: 0, uploads: 0, exports: 0, logos: 0, photos: 0 },
});
// The smallest total that is at `percent` of the cap.
const atPercent = (percent: number) => Math.ceil((CAP * percent) / 100);

function alerter(
  options: {
    used?: number;
    at?: Date;
    fake?: FakeEmailSender;
    db?: AppTotalDb;
    getUsage?: () => Promise<AppStorageUsage>;
  } = {},
) {
  const fake = options.fake ?? createFakeEmailSender();
  return {
    fake,
    ...createStorageAlerter({
      db: options.db ?? t.db,
      getSender: () => fake.send,
      now: () => options.at ?? NOW,
      getUsage: options.getUsage ?? (() => Promise.resolve(usageOf(options.used ?? 0))),
    }),
  };
}

const markers = () =>
  t.db
    .select()
    .from(verification)
    .where(like(verification.identifier, "storage-alert:%"));

// Wraps the transaction of a (recordLocks) database so its select, delete and insert calls push
// their kind into `events`, in the order they run.
function recordWrites(db: AppTotalDb, events: string[]): AppTotalDb {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "transaction") return Reflect.get(target, prop, receiver) as unknown;
      return (callback: (tx: object) => Promise<unknown>, ...rest: unknown[]) =>
        (
          target as unknown as {
            transaction: (
              cb: (tx: object) => Promise<unknown>,
              ...r: unknown[]
            ) => unknown;
          }
        ).transaction(
          (tx) =>
            callback(
              new Proxy(tx, {
                get(inner, name, innerReceiver) {
                  const value = Reflect.get(inner, name, innerReceiver) as unknown;
                  if (
                    (name === "select" || name === "delete" || name === "insert") &&
                    typeof value === "function"
                  ) {
                    return (...args: unknown[]) => {
                      events.push(name);
                      return (value as (...a: unknown[]) => unknown).apply(inner, args);
                    };
                  }
                  return value;
                },
              }),
            ),
          ...rest,
        );
    },
  });
}

// A database whose first `failures` calls of update() reject (the marker extension is the first
// update the alert makes; the budget's confirm comes after it).
function failingUpdates(db: AppTotalDb, failures: number): AppTotalDb {
  let left = failures;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "update" && left > 0) {
        return () => {
          left -= 1;
          throw new Error("update refused");
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

describe("STORAGE_ALERT_LEVELS", () => {
  it("is 80 percent and 100 percent", () => {
    expect([...STORAGE_ALERT_LEVELS]).toEqual([0.8, 1]);
  });
});

describe("checkStorageAlerts levels", () => {
  it("sends nothing at 79 percent and leaves no marker", async () => {
    const a = alerter({ used: atPercent(80) - 1 });
    expect(await a.check()).toEqual({});
    expect(a.fake.messages).toHaveLength(0);
    expect(await markers()).toHaveLength(0);
  });

  it("sends one email to the admin at exactly 80 percent", async () => {
    const a = alerter({ used: atPercent(80) });
    expect(await a.check()).toEqual({});
    expect(a.fake.messages).toHaveLength(1);
    const [mail] = a.fake.messages;
    expect(mail.to).toBe(ADMIN);
    expect(mail.subject).toBe("Penyimpanan MitraMatika hampir penuh");
    expect(mail.text).toContain("4.915 MB");
    expect(mail.text).toContain("6.144 MB");
    expect(mail.text).toContain("80%");
    expect(mail.text).toContain("Object storage");
    const rows = await markers();
    expect(rows).toHaveLength(1);
    expect(rows[0].identifier).toBe("storage-alert:0.8");
    expect(rows[0].value).toBe("2026-11");
    expect(rows[0].expiresAt.getTime()).toBe(NOW.getTime() + 30 * DAY);
  });

  it("does not mail again on a second tick the same day or within 30 days", async () => {
    const used = atPercent(85);
    const first = alerter({ used });
    await first.check();
    const again = alerter({ used, fake: first.fake });
    await again.check();
    const later = alerter({
      used,
      fake: first.fake,
      at: new Date(NOW.getTime() + 29 * DAY),
    });
    await later.check();
    expect(first.fake.messages).toHaveLength(1);
    expect(await markers()).toHaveLength(1);
  });

  it("mails once more at 100 percent even though 80 percent was sent", async () => {
    const a = alerter({ used: atPercent(80) });
    await a.check();
    const full = alerter({ used: CAP, fake: a.fake, at: new Date(NOW.getTime() + DAY) });
    await full.check();
    expect(a.fake.messages.map((m) => m.subject)).toEqual([
      "Penyimpanan MitraMatika hampir penuh",
      "Penyimpanan MitraMatika penuh",
    ]);
    expect(a.fake.messages[1].text).toContain("100%");
    expect(
      (await markers()).map((m) => m.identifier).sort((x, y) => x.localeCompare(y)),
    ).toEqual(["storage-alert:0.8", "storage-alert:1"]);
    // A further tick at 100 percent stays quiet.
    await full.check();
    expect(a.fake.messages).toHaveLength(2);
  });

  it("goes straight to the full alert when the total jumps past 100 percent", async () => {
    const a = alerter({ used: CAP + 5 * MB });
    await a.check();
    expect(a.fake.messages.map((m) => m.subject)).toEqual([
      "Penyimpanan MitraMatika penuh",
    ]);
    expect((await markers()).map((m) => m.identifier)).toEqual(["storage-alert:1"]);
  });

  it("does not send the 80 percent alert after the full one when the total drops back", async () => {
    const full = alerter({ used: CAP });
    await full.check();
    const dropped = alerter({
      used: atPercent(85),
      fake: full.fake,
      at: new Date(NOW.getTime() + DAY),
    });
    await dropped.check();
    expect(full.fake.messages).toHaveLength(1);
  });

  it("mails again after 30 days when the 80 percent marker has expired and the total is still high", async () => {
    const used = atPercent(90);
    const a = alerter({ used });
    await a.check();
    const later = alerter({
      used,
      fake: a.fake,
      at: new Date(NOW.getTime() + 30 * DAY + 1000),
    });
    await later.check();
    expect(a.fake.messages).toHaveLength(2);
    const rows = await markers();
    expect(rows).toHaveLength(1);
    expect(rows[0].expiresAt.getTime()).toBe(NOW.getTime() + 60 * DAY + 1000);
  });

  it("two ticks at once send one email", async () => {
    const fake = createFakeEmailSender();
    const used = atPercent(81);
    await Promise.all([alerter({ used, fake }).check(), alerter({ used, fake }).check()]);
    expect(fake.messages).toHaveLength(1);
    expect(await markers()).toHaveLength(1);
  });

  it("takes the claim under the advisory lock before it writes the marker", async () => {
    const events: string[] = [];
    const db = recordWrites(recordLocks(t.db, events), events);
    const a = alerter({ used: atPercent(80), db });
    await a.check();
    // The whole transaction, in order: the lock, then the delete of an expired marker and the
    // insert of the new one (PGlite cannot show a missing lock by a race; the order can).
    expect(events).toEqual(["lock:storage_alert", "select", "delete", "insert"]);
    expect(a.fake.messages).toHaveLength(1);
  });
});

describe("checkStorageAlerts failures and refusals", () => {
  it("a failed send deletes the marker so the next tick retries", async () => {
    const used = atPercent(80);
    const failing = createFakeEmailSender({ fail: "provider_down" });
    const first = alerter({ used, fake: failing });
    expect(await first.check()).toEqual({ failed: true });
    expect(failing.messages).toHaveLength(0);
    expect(await markers()).toHaveLength(0);
    const retry = alerter({ used, at: new Date(NOW.getTime() + DAY) });
    await retry.check();
    expect(retry.fake.messages).toHaveLength(1);
    expect(await markers()).toHaveLength(1);
  });

  it("a sender that throws deletes the marker and the budget slot too", async () => {
    const used = atPercent(80);
    const fake = createFakeEmailSender();
    const throwing: FakeEmailSender = {
      messages: fake.messages,
      send: () => Promise.reject(new Error(`boom for ${ADMIN}`)),
    };
    const a = alerter({ used, fake: throwing });
    expect(await a.check()).toEqual({ failed: true });
    expect(await markers()).toHaveLength(0);
    const budgetRows = await t.db
      .select()
      .from(verification)
      .where(like(verification.identifier, "%-day:%"));
    expect(budgetRows).toHaveLength(0);
    expect(logs.join("\n")).not.toContain(ADMIN);
  });

  it("holds the marker only briefly while the send is in flight, then for 30 days", async () => {
    let during: Date | undefined;
    const fake = createFakeEmailSender();
    const probing: FakeEmailSender = {
      messages: fake.messages,
      send: async (message) => {
        const [row] = await markers();
        during = row.expiresAt;
        return fake.send(message);
      },
    };
    await alerter({ used: atPercent(80), fake: probing }).check();
    // A task killed after the claim gives the marker back within the hour, not in 30 days.
    expect(during).toBeDefined();
    expect(during!.getTime() - NOW.getTime()).toBeLessThanOrEqual(60 * 60 * 1000);
    expect((await markers())[0].expiresAt.getTime()).toBe(NOW.getTime() + 30 * DAY);
  });

  it("retries a failed 30-day extension once: no duplicate on the next tick", async () => {
    const used = atPercent(80);
    const a = alerter({ used, db: failingUpdates(t.db, 1) });
    expect(await a.check()).toEqual({});
    expect(logs.filter((l) => l.includes("retrying once"))).toHaveLength(1);
    expect((await markers())[0].expiresAt.getTime()).toBe(NOW.getTime() + 30 * DAY);
    await alerter({
      used,
      fake: a.fake,
      at: new Date(NOW.getTime() + DAY),
    }).check();
    expect(a.fake.messages).toHaveLength(1);
  });

  it("logs and reports the step failed when the extension fails twice", async () => {
    const a = alerter({ used: atPercent(80), db: failingUpdates(t.db, 2) });
    expect(await a.check()).toEqual({ failed: true });
    expect(a.fake.messages).toHaveLength(1);
    expect(logs.filter((l) => l.includes("may send the alert again"))).toHaveLength(1);
    expect(logs.join(" ")).not.toContain(ADMIN);
  });

  it("sends nothing and claims nothing when ADMIN_EMAIL is unset, and logs once without an address", async () => {
    vi.stubEnv("ADMIN_EMAIL", "");
    const a = alerter({ used: atPercent(95) });
    expect(await a.check()).toEqual({});
    expect(a.fake.messages).toHaveLength(0);
    expect(await markers()).toHaveLength(0);
    const warnings = logs.filter((line) => line.includes("no admin address"));
    expect(warnings).toHaveLength(1);
    expect(logs.join("\n")).not.toContain("@");
  });

  it("does not warn about a missing admin address while the total is low", async () => {
    vi.stubEnv("ADMIN_EMAIL", "");
    await alerter({ used: 10 }).check();
    expect(logs).toHaveLength(0);
  });

  it("a refused budget sends nothing, leaves no marker and sends the next day", async () => {
    const budget = createGlobalSendBudget(t.db, () => NOW);
    for (let i = 0; i < ADMIN_NOTICES_PER_DAY; i += 1) {
      expect(await budget.reserve("adminDigest")).not.toBeNull();
    }
    const used = atPercent(80);
    const a = alerter({ used });
    expect(await a.check()).toEqual({ backlogLeft: true });
    expect(a.fake.messages).toHaveLength(0);
    expect(await markers()).toHaveLength(0);
    const next = alerter({ used, fake: a.fake, at: new Date(NOW.getTime() + DAY) });
    await next.check();
    expect(a.fake.messages).toHaveLength(1);
  });

  it("never takes the reset reserve: at 60 app-wide emails the alert is refused and a reset still goes", async () => {
    const budget = createGlobalSendBudget(t.db, () => NOW);
    for (let i = 0; i < AUTH_EMAILS_PER_DAY - RESET_EMAIL_RESERVE; i += 1) {
      expect(await budget.reserve("verify")).not.toBeNull();
    }
    const a = alerter({ used: CAP });
    await a.check();
    expect(a.fake.messages).toHaveLength(0);
    expect(await markers()).toHaveLength(0);
    expect(await budget.reserve("reset")).not.toBeNull();
  });

  it("still goes after ten single notices (the last two admin slots are kept for it)", async () => {
    const budget = createGlobalSendBudget(t.db, () => NOW);
    for (let i = 0; i < 10; i += 1) {
      expect(await budget.reserve("adminNotice")).not.toBeNull();
    }
    expect(await budget.reserve("adminNotice")).toBeNull();
    const a = alerter({ used: atPercent(80) });
    await a.check();
    expect(a.fake.messages).toHaveLength(1);
  });

  it("a failing total reports the step failed, sends nothing and logs no address", async () => {
    const a = alerter({
      getUsage: () => Promise.reject(new Error(`db down for ${ADMIN}`)),
    });
    expect(await a.check()).toEqual({ failed: true });
    expect(a.fake.messages).toHaveLength(0);
    expect(logs.join("\n")).not.toContain(ADMIN);
  });
});

describe("storage alert privacy and wiring", () => {
  it("the email and the logs carry no address of any teacher", async () => {
    await t.db.execute(
      sql`insert into "user" (id, name, email, email_verified) values (${USER_A}, 'Bu Rahasia', ${TEACHER}, true) on conflict (id) do update set email = ${TEACHER}, name = 'Bu Rahasia'`,
    );
    const a = alerter({ used: CAP });
    await a.check();
    const [mail] = a.fake.messages;
    expect(mail.text).not.toContain(TEACHER);
    expect(mail.text).not.toContain("Rahasia");
    expect(mail.subject).not.toContain("@");
    expect(logs.join("\n")).not.toContain(TEACHER);
    expect(logs.join("\n")).not.toContain(ADMIN);
  });

  it("the default total is the real database total (80 percent of the cap in one material)", async () => {
    await t.db.execute(
      sql`truncate "user", profiles, jobs, materials, material_uploads, exports, school_templates, solver_sessions, assessments, folders restart identity cascade`,
    );
    await t.db.execute(
      sql`insert into "user" (id, name, email, email_verified) values (${USER_A}, 'A', ${TEACHER}, true), (${USER_B}, 'B', 'b@example.test', true)`,
    );
    await t.db.execute(
      sql`insert into profiles (id, display_name) values (${USER_A}, 'A'), (${USER_B}, 'B')`,
    );
    await t.db.execute(sql`truncate curriculum_versions restart identity cascade`);
    await seedFixtures(t.db);
    const fake = createFakeEmailSender();
    const real = createStorageAlerter({
      db: t.db,
      getSender: () => fake.send,
      now: () => NOW,
    });
    await real.check();
    expect(fake.messages).toHaveLength(0);
    await t.db.execute(
      sql`update materials set size_bytes = ${atPercent(80)} where id = ${FIXTURE.material(1)}`,
    );
    await real.check();
    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0].text).not.toContain(TEACHER);
    await t.db
      .delete(verification)
      .where(eq(verification.identifier, "storage-alert:0.8"));
  });
});
