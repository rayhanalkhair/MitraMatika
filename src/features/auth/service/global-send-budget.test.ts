import { like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verification } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  type TestDatabase,
} from "@/lib/db/test-harness";
import {
  ADMIN_INDIVIDUAL_NOTICES_PER_DAY,
  ADMIN_NOTICES_PER_DAY,
  AUTH_EMAILS_PER_DAY,
  createGlobalSendBudget,
  jakartaDay,
  RESERVATION_HOLD_SECONDS,
  RESET_EMAIL_RESERVE,
} from "./global-send-budget";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await t.client.close();
});
beforeEach(async () => {
  await t.db.delete(verification);
});

// 08:00 in Jakarta on 17 November 2026.
const START = Date.parse("2026-11-17T01:00:00.000Z");

describe("jakartaDay", () => {
  it("keys the day in Asia/Jakarta and ends it at the next Jakarta midnight", () => {
    expect(jakartaDay(new Date("2026-11-17T16:59:59.000Z"))).toEqual({
      key: "2026-11-17",
      end: new Date("2026-11-17T17:00:00.000Z"),
    });
    expect(jakartaDay(new Date("2026-11-17T17:00:00.000Z")).key).toBe("2026-11-18");
  });
});

describe("createGlobalSendBudget", () => {
  it("is 80 a day with the last 20 kept for reset emails", () => {
    expect(AUTH_EMAILS_PER_DAY).toBe(80);
    expect(RESET_EMAIL_RESERVE).toBe(20);
  });

  it(
    "stops other emails at 60, keeps 20 for resets, and starts again the next Jakarta day",
    async () => {
      let clock = START;
      const budget = createGlobalSendBudget(t.db, () => new Date(clock));
      const allowed = async (
        purpose: "verify" | "reset" | "accountExists",
        n: number,
      ) => {
        let yes = 0;
        for (let i = 0; i < n; i += 1)
          if ((await budget.reserve(purpose)) !== null) yes += 1;
        return yes;
      };
      expect(await allowed("verify", 50)).toBe(50);
      expect(await allowed("accountExists", 15)).toBe(10);
      // Refused sends used nothing: the reserve is whole.
      expect(await allowed("reset", 25)).toBe(20);
      expect(await allowed("verify", 1)).toBe(0);
      // Midnight in Jakarta (17:00 UTC).
      clock = Date.parse("2026-11-17T17:00:00.000Z");
      expect(await allowed("verify", 1)).toBe(1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "never lets verification or account-exists emails into the reset reserve, in any order",
    async () => {
      const budget = createGlobalSendBudget(t.db, () => new Date(START));
      let resets = 0;
      // Resets first, then a flood of the other kinds: they still stop at 60 in total.
      for (let i = 0; i < 10; i += 1)
        if ((await budget.reserve("reset")) !== null) resets += 1;
      let others = 0;
      for (let i = 0; i < 100; i += 1) {
        const purpose = i % 2 === 0 ? "verify" : "accountExists";
        if ((await budget.reserve(purpose)) !== null) others += 1;
      }
      expect(resets + others).toBe(AUTH_EMAILS_PER_DAY - RESET_EMAIL_RESERVE);
      // The 20 of the reserve are all there for resets.
      for (let i = 0; i < 30; i += 1)
        if ((await budget.reserve("reset")) !== null) resets += 1;
      expect(resets + others).toBe(AUTH_EMAILS_PER_DAY);
      expect(others).toBe(AUTH_EMAILS_PER_DAY - RESET_EMAIL_RESERVE - 10);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "gives a released reservation back",
    async () => {
      const budget = createGlobalSendBudget(t.db, () => new Date(START));
      for (let i = 0; i < AUTH_EMAILS_PER_DAY - RESET_EMAIL_RESERVE - 1; i += 1) {
        const reservation = await budget.reserve("verify");
        expect(reservation).not.toBeNull();
        if (reservation) await budget.confirm(reservation);
      }
      const last = await budget.reserve("verify");
      expect(last).not.toBeNull();
      expect(await budget.reserve("verify")).toBeNull();
      if (last === null) throw new Error("expected a reservation");
      await budget.release(last);
      expect(await budget.reserve("verify")).not.toBeNull();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "lets an unconfirmed reservation lapse after the hold, and keeps a confirmed one all day",
    async () => {
      let clock = START;
      const budget = createGlobalSendBudget(t.db, () => new Date(clock));
      const confirmed = await budget.reserve("verify");
      if (confirmed === null) throw new Error("expected a reservation");
      await budget.confirm(confirmed);
      for (let i = 0; i < AUTH_EMAILS_PER_DAY - RESET_EMAIL_RESERVE - 1; i += 1) {
        expect(await budget.reserve("verify")).not.toBeNull();
      }
      expect(await budget.reserve("verify")).toBeNull();
      // The task that held the unconfirmed ones died: their slots come back after the hold.
      clock += RESERVATION_HOLD_SECONDS * 1000;
      let again = 0;
      for (let i = 0; i < 100; i += 1)
        if ((await budget.reserve("verify")) !== null) again += 1;
      // Only the confirmed one still counts.
      expect(again).toBe(AUTH_EMAILS_PER_DAY - RESET_EMAIL_RESERVE - 1);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("admin notices in the budget (ADR-0022)", () => {
  const budgetAt = (clock = () => new Date(START)) => createGlobalSendBudget(t.db, clock);
  const rows = (prefix: string) =>
    t.db
      .select()
      .from(verification)
      .where(like(verification.identifier, `${prefix}%`));

  it("pins the numbers: 12 a day for the admin, 10 of them for single notices", () => {
    expect(ADMIN_NOTICES_PER_DAY).toBe(12);
    expect(ADMIN_INDIVIDUAL_NOTICES_PER_DAY).toBe(10);
  });

  it(
    "30 notices in one day: 10 individual ones go, the 11th is refused, a digest still goes",
    async () => {
      const budget = budgetAt();
      let sent = 0;
      for (let i = 0; i < 30; i += 1) {
        const reservation = await budget.reserve("adminNotice");
        if (reservation !== null) {
          sent += 1;
          await budget.confirm(reservation);
        }
      }
      expect(sent).toBe(ADMIN_INDIVIDUAL_NOTICES_PER_DAY);
      // The last two of the sub-budget are for digests and storage alerts.
      expect(await budget.reserve("adminDigest")).not.toBeNull();
      expect(await budget.reserve("adminDigest")).not.toBeNull();
      expect(await budget.reserve("adminDigest")).toBeNull();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "never takes the reset reserve: at 60 verification emails notices are refused and 20 resets still go",
    async () => {
      const budget = budgetAt();
      for (let i = 0; i < AUTH_EMAILS_PER_DAY - RESET_EMAIL_RESERVE; i += 1) {
        expect(await budget.reserve("verify")).not.toBeNull();
      }
      expect(await budget.reserve("adminNotice")).toBeNull();
      expect(await budget.reserve("adminDigest")).toBeNull();
      let resets = 0;
      for (let i = 0; i < 30; i += 1)
        if ((await budget.reserve("reset")) !== null) resets += 1;
      expect(resets).toBe(RESET_EMAIL_RESERVE);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "counts in the app-wide label too: notices use slots of the 60",
    async () => {
      const budget = budgetAt();
      for (let i = 0; i < 10; i += 1) {
        expect(await budget.reserve("adminNotice")).not.toBeNull();
      }
      let verify = 0;
      for (let i = 0; i < 80; i += 1)
        if ((await budget.reserve("verify")) !== null) verify += 1;
      expect(verify).toBe(AUTH_EMAILS_PER_DAY - RESET_EMAIL_RESERVE - 10);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a refusal leaves no row behind, in either label",
    async () => {
      const budget = budgetAt();
      for (let i = 0; i < ADMIN_INDIVIDUAL_NOTICES_PER_DAY; i += 1) {
        await budget.reserve("adminNotice");
      }
      const before = [
        (await rows("auth-email-day:")).length,
        (await rows("admin-notice-day:")).length,
      ];
      expect(before).toEqual([10, 10]);
      expect(await budget.reserve("adminNotice")).toBeNull();
      expect([
        (await rows("auth-email-day:")).length,
        (await rows("admin-notice-day:")).length,
      ]).toEqual(before);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "release and confirm settle both rows",
    async () => {
      let clock = START;
      const budget = budgetAt(() => new Date(clock));
      const held: NonNullable<Awaited<ReturnType<typeof budget.reserve>>>[] = [];
      for (let i = 0; i < ADMIN_INDIVIDUAL_NOTICES_PER_DAY; i += 1) {
        const r = await budget.reserve("adminNotice");
        if (r === null) throw new Error("expected a reservation");
        held.push(r);
      }
      expect(await budget.reserve("adminNotice")).toBeNull();
      await budget.release(held[0]);
      expect((await rows("auth-email-day:")).length).toBe(9);
      expect((await rows("admin-notice-day:")).length).toBe(9);
      await budget.confirm(held[1]);
      // After the hold the unconfirmed eight lapse; the confirmed one still counts in both rows.
      clock += RESERVATION_HOLD_SECONDS * 1000;
      let again = 0;
      for (let i = 0; i < 20; i += 1)
        if ((await budget.reserve("adminNotice")) !== null) again += 1;
      expect(again).toBe(ADMIN_INDIVIDUAL_NOTICES_PER_DAY - 1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "starts again the next Jakarta day",
    async () => {
      let clock = START;
      const budget = budgetAt(() => new Date(clock));
      for (let i = 0; i < 12; i += 1) {
        const r = await budget.reserve("adminDigest");
        if (r) await budget.confirm(r);
      }
      expect(await budget.reserve("adminDigest")).toBeNull();
      clock = Date.parse("2026-11-17T17:00:00.000Z");
      expect(await budget.reserve("adminNotice")).not.toBeNull();
    },
    DB_TEST_TIMEOUT,
  );
});
