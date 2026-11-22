import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verification } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  type TestDatabase,
} from "@/lib/db/test-harness";
import {
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
