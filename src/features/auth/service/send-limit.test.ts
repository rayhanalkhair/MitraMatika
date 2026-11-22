import { describe, expect, it } from "vitest";
import { verification } from "@/lib/db/schema";
import { createTestDatabase, DB_TEST_TIMEOUT } from "@/lib/db/test-harness";
import { createSendLimiter, sendLimitIdentifiers } from "./send-limit";

// The per-address email limit on its own: 1 per 60 s for each kind of account email; for
// verification and reset emails each (no shared budget), 3 per hour per (address, client IP) and
// 20 per day per address; account-exists emails 3 per hour per address (ruling S5). On a clock the
// test moves.
const SECRET = "test-secret-".padEnd(40, "x");
const TEACHER = "guru@example.test";
const OTHER = "guru2@example.test";
const IP = "198.51.100.1";

async function harness() {
  const t = await createTestDatabase();
  let clock = Date.parse("2026-11-16T10:00:00.000Z");
  const limiter = createSendLimiter(t.db, SECRET, "verify", () => new Date(clock));
  return {
    t,
    clock: () => new Date(clock),
    allow: (email = TEACHER, ip: string | undefined = IP) => limiter.allow(email, ip),
    advance: (seconds: number) => {
      clock += seconds * 1000;
    },
  };
}

describe("createSendLimiter", () => {
  it(
    "allows one send, refuses another within 60 s, and allows one at exactly 60 s",
    async () => {
      const { allow, advance } = await harness();
      expect(await allow()).toBe(true);
      advance(59);
      expect(await allow()).toBe(false);
      // The cooldown is per address: another IP is held back too.
      expect(await allow(TEACHER, "198.51.100.2")).toBe(false);
      advance(1);
      expect(await allow()).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "allows 3 per hour from one client IP, one more 3600 s after the oldest, and other IPs their own 3",
    async () => {
      const { allow, advance } = await harness();
      for (let i = 0; i < 3; i += 1) {
        expect(await allow()).toBe(true);
        advance(60);
      }
      // Now 180 s after the first send.
      expect(await allow()).toBe(false);
      // The owner, from another network, still gets the email.
      expect(await allow(TEACHER, "203.0.113.9")).toBe(true);
      advance(3600 - 180 - 1);
      expect(await allow()).toBe(false);
      advance(1);
      expect(await allow()).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "caps an address at 20 per day across all IPs, and a request without an IP shares one key",
    async () => {
      const { allow, advance } = await harness();
      let sent = 0;
      for (let ip = 1; ip <= 7; ip += 1) {
        for (let i = 0; i < 3; i += 1) {
          if (await allow(TEACHER, `203.0.113.${String(ip)}`)) sent += 1;
          advance(60);
        }
      }
      expect(sent).toBe(20);
      expect(await allow(TEACHER, "203.0.113.99")).toBe(false);
      expect(await allow(OTHER, "203.0.113.99")).toBe(true);
      advance(24 * 3600);
      expect(await allow(TEACHER, "203.0.113.99")).toBe(true);
      // No IP: all such requests share the one pair key.
      for (let i = 0; i < 3; i += 1) {
        advance(60);
        expect(await allow(OTHER, undefined)).toBe(true);
      }
      advance(60);
      expect(await allow(OTHER, undefined)).toBe(false);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "counts two IPv6 addresses of one /64 as one client, and IPv4 addresses as they are",
    async () => {
      const { allow, advance } = await harness();
      const net = "2001:db8:abcd:12";
      for (let i = 1; i <= 3; i += 1) {
        expect(await allow(TEACHER, `${net}::${String(i)}`)).toBe(true);
        advance(60);
      }
      // A fresh address in the same /64 is the same client.
      expect(await allow(TEACHER, `${net}:ffff::9`)).toBe(false);
      expect(await allow(TEACHER, "2001:db8:abcd:13::1")).toBe(true);
      advance(60);
      expect(await allow(TEACHER, "203.0.113.1")).toBe(true);
      advance(60);
      expect(await allow(TEACHER, "203.0.113.2")).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "keeps addresses independent and treats case and spaces as the same address",
    async () => {
      const { allow } = await harness();
      expect(await allow(TEACHER)).toBe(true);
      expect(await allow(" Guru@Example.TEST ")).toBe(false);
      expect(await allow(OTHER)).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "stores only keyed hashes, never the address or the IP",
    async () => {
      const { t, allow } = await harness();
      await allow();
      const rows = await t.db.select().from(verification);
      expect(rows.map((row) => row.identifier).sort()).toEqual([
        expect.stringMatching(/^email-sent:verify:[0-9a-f]{64}$/),
        expect.stringMatching(/^email-sent:verifyDaily:[0-9a-f]{64}$/),
        expect.stringMatching(/^email-sent:verifyPairHourly:[0-9a-f]{64}$/),
      ]);
      expect(rows.map((row) => row.value)).toEqual(["1", "1", "1"]);
      expect(JSON.stringify(rows)).not.toContain(TEACHER);
      expect(JSON.stringify(rows)).not.toContain(IP);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "gives reset emails a budget of their own: used-up verification sends never block a reset",
    async () => {
      const { allow, advance, clock, t } = await harness();
      const reset = createSendLimiter(t.db, SECRET, "reset", clock);
      for (let i = 0; i < 3; i += 1) {
        expect(await allow()).toBe(true);
        advance(60);
      }
      expect(await allow()).toBe(false);
      for (let i = 0; i < 3; i += 1) {
        expect(await reset.allow(TEACHER, IP)).toBe(true);
        advance(60);
      }
      expect(await reset.allow(TEACHER, IP)).toBe(false);
      // An hour of reset requests from one attacker IP leaves the owner's own reset alone.
      expect(await reset.allow(TEACHER, "203.0.113.50")).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "gives account-exists emails their own budget (60 s, 3 per hour per address)",
    async () => {
      const { allow, advance, clock, t } = await harness();
      const exists = createSendLimiter(t.db, SECRET, "accountExists", clock);
      expect(await exists.allow(TEACHER)).toBe(true);
      advance(59);
      expect(await exists.allow(TEACHER)).toBe(false);
      advance(1);
      expect(await exists.allow(TEACHER)).toBe(true);
      advance(60);
      expect(await exists.allow(TEACHER, "203.0.113.7")).toBe(true);
      advance(60);
      // The fourth within the hour is refused, whatever the IP.
      expect(await exists.allow(TEACHER, "203.0.113.8")).toBe(false);
      // They never used the verification budget.
      expect(await allow()).toBe(true);
      advance(3600 - 180);
      expect(await exists.allow(TEACHER)).toBe(true);
      expect(await exists.allow(OTHER)).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "lists every identifier written for an address alone (account deletion deletes them)",
    async () => {
      const { t, allow, clock } = await harness();
      await allow();
      await createSendLimiter(t.db, SECRET, "reset", clock).allow(TEACHER, IP);
      await createSendLimiter(t.db, SECRET, "accountExists", clock).allow(TEACHER);
      const written = (await t.db.select().from(verification)).map((r) => r.identifier);
      const listed = sendLimitIdentifiers(SECRET, " Guru@Example.TEST ");
      // Everything except the two per-pair rows, which expire within the hour.
      expect(written.filter((id) => !listed.includes(id)).sort()).toEqual([
        expect.stringMatching(/^email-sent:resetPairHourly:/),
        expect.stringMatching(/^email-sent:verifyPairHourly:/),
      ]);
      expect(listed.filter((id) => !written.includes(id))).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );
});
