import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, DB_TEST_TIMEOUT } from "@/lib/db/test-harness";
import type { SendEmail } from "@/lib/email";
import { createFakeEmailSender } from "@/lib/email/fake";
import { logger } from "@/lib/logger";
import {
  createAuthEmails,
  RESET_LINK_EXPIRES_IN_SECONDS,
  VERIFICATION_LINK_EXPIRES_IN_SECONDS,
} from "./auth-emails";
import { AUTH_EMAILS_PER_DAY, RESET_EMAIL_RESERVE } from "./global-send-budget";
import { sendLimitIdentifiers } from "./send-limit";
import { verification } from "@/lib/db/schema";

const SECRET = "test-secret-".padEnd(40, "x");
const APP = "http://localhost:3000";
const TEACHER = "guru@example.test";
const VERIFY_URL = `${APP}/api/auth/verify-email?token=tok.en.jwt&callbackURL=%2F`;
const RESET_URL = `${APP}/api/auth/reset-password/tok3n?callbackURL=%2Freset-password`;

beforeEach(() => {
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function harness(options: { sender?: SendEmail } = {}) {
  const t = await createTestDatabase();
  const fake = createFakeEmailSender();
  const pending: Promise<unknown>[] = [];
  let clock = Date.parse("2026-11-17T08:00:00.000Z");
  const emails = createAuthEmails({
    db: t.db,
    secret: SECRET,
    appUrl: APP,
    getSender: () => options.sender ?? fake.send,
    runInBackground: (task) => {
      pending.push(task);
    },
    now: () => new Date(clock),
  });
  return {
    t,
    fake,
    emails,
    pending,
    flush: async () => {
      while (pending.length > 0) await Promise.all(pending.splice(0));
    },
    advance: (seconds: number) => {
      clock += seconds * 1000;
    },
  };
}

describe("link lifetimes", () => {
  it("are 24 hours for verification and 1 hour for a reset", () => {
    expect(VERIFICATION_LINK_EXPIRES_IN_SECONDS).toBe(24 * 60 * 60);
    expect(RESET_LINK_EXPIRES_IN_SECONDS).toBe(60 * 60);
  });
});

describe("createAuthEmails", () => {
  it(
    "hands the work to the background and returns before anything is sent",
    async () => {
      const { emails, fake, pending, flush } = await harness();
      await emails.sendVerificationEmail({ email: TEACHER, url: VERIFY_URL });
      expect(pending).toHaveLength(1);
      expect(fake.messages).toEqual([]);
      await flush();
      expect(fake.messages).toHaveLength(1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "resolves even when the send never finishes",
    async () => {
      const { emails } = await harness({ sender: () => new Promise(() => undefined) });
      await expect(
        emails.sendVerificationEmail({ email: TEACHER, url: VERIFY_URL }),
      ).resolves.toBeUndefined();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "sends the verification link in Indonesian with its 24 hour lifetime",
    async () => {
      const { emails, fake, flush } = await harness();
      await emails.sendVerificationEmail({ email: TEACHER, url: VERIFY_URL });
      await flush();
      expect(fake.messages).toEqual([
        {
          to: TEACHER,
          subject: "Konfirmasi email akun MitraMatika",
          text: expect.stringContaining(VERIFY_URL) as string,
        },
      ]);
      expect(fake.messages[0].text).toContain("24 jam");
      // Someone else may have signed up with this address (ruling S8): the owner is told not to
      // open the link.
      expect(fake.messages[0].text).toContain(
        "Jika bukan Anda, jangan buka tautan ini dan abaikan email ini",
      );
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "sends the reset link with its 60 minute lifetime",
    async () => {
      const { emails, fake, flush } = await harness();
      await emails.sendResetEmail({ email: TEACHER, url: RESET_URL });
      await flush();
      expect(fake.messages).toHaveLength(1);
      expect(fake.messages[0].subject).toBe("Atur ulang kata sandi MitraMatika");
      expect(fake.messages[0].text).toContain(RESET_URL);
      expect(fake.messages[0].text).toContain("60 menit");
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "tells an existing account holder where to sign in or reset the password",
    async () => {
      const { emails, fake, flush } = await harness();
      await emails.sendAccountExistsEmail({ email: TEACHER });
      await flush();
      expect(fake.messages).toHaveLength(1);
      expect(fake.messages[0].to).toBe(TEACHER);
      expect(fake.messages[0].subject).toBe("Akun MitraMatika Anda sudah ada");
      expect(fake.messages[0].text).toContain(`${APP}/sign-in`);
      expect(fake.messages[0].text).toContain(`${APP}/forgot-password`);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "sends at most one email of a kind per address per minute, and 3 per hour per client IP of each kind on its own budget",
    async () => {
      const { emails, fake, flush, advance } = await harness();
      const send = async (
        kind: "verify" | "reset",
        ip = "198.51.100.1",
        email = TEACHER,
      ) => {
        const sent =
          kind === "verify"
            ? emails.sendVerificationEmail({ email, url: VERIFY_URL, ip })
            : emails.sendResetEmail({ email, url: RESET_URL, ip });
        // The caller's answer never depends on the limit.
        await expect(sent).resolves.toBeUndefined();
        await flush();
        return fake.messages.length;
      };
      expect(await send("verify")).toBe(1);
      advance(59);
      expect(await send("verify")).toBe(1);
      // A different kind is not held back by the verification cooldown.
      expect(await send("reset")).toBe(2);
      advance(1);
      expect(await send("verify")).toBe(3);
      advance(60);
      expect(await send("verify")).toBe(4);
      advance(60);
      // The fourth verification email from this IP within the hour is skipped silently...
      expect(await send("verify")).toBe(4);
      // ...while resets have their own budget, and another IP has its own 3.
      expect(await send("reset")).toBe(5);
      expect(await send("verify", "203.0.113.5")).toBe(6);
      // Another address is unaffected.
      advance(60);
      expect(await send("verify", "198.51.100.1", "lain@example.test")).toBe(7);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "limits account-exists emails on their own, so they can never block a reset email",
    async () => {
      const { emails, fake, flush, advance } = await harness();
      const subjects = () => fake.messages.map((m) => m.subject);
      // An attacker repeats sign-ups with the victim's address, once a minute for an hour.
      for (let i = 0; i < 60; i += 1) {
        await expect(
          emails.sendAccountExistsEmail({ email: TEACHER }),
        ).resolves.toBeUndefined();
        await flush();
        advance(60);
      }
      // At most 3 account-exists emails in that hour...
      expect(subjects()).toEqual(Array(3).fill("Akun MitraMatika Anda sudah ada"));
      // ...and the victim's own reset requests still get through (3 per hour from one IP).
      for (let i = 0; i < 3; i += 1) {
        await emails.sendResetEmail({
          email: TEACHER,
          url: RESET_URL,
          ip: "198.51.100.1",
        });
        await flush();
        advance(60);
      }
      expect(
        subjects().filter((s) => s === "Atur ulang kata sandi MitraMatika"),
      ).toHaveLength(3);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "stops verification emails at the app-wide daily budget, logs it, and keeps the reserve for resets",
    async () => {
      const { emails, fake, flush } = await harness();
      const limit = AUTH_EMAILS_PER_DAY - RESET_EMAIL_RESERVE;
      // A sign-up flood to distinct invented addresses.
      for (let i = 0; i <= limit; i += 1) {
        await emails.sendVerificationEmail({
          email: `orang${String(i)}@example.test`,
          url: VERIFY_URL,
        });
        await flush();
      }
      expect(fake.messages).toHaveLength(limit);
      expect(logger.error).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(vi.mocked(logger.error).mock.calls);
      expect(logged).toContain("daily");
      expect(logged).not.toContain("orang");
      // A teacher's reset still goes out.
      await emails.sendResetEmail({ email: TEACHER, url: RESET_URL });
      await flush();
      expect(fake.messages.at(-1)?.to).toBe(TEACHER);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "an email refused by either budget uses up neither",
    async () => {
      const { t, emails, fake, flush, advance } = await harness();
      const rows = async () =>
        (await t.db.select().from(verification)).map((r) => r.identifier);
      const perAddress = (email: string) =>
        sendLimitIdentifiers(SECRET, email).filter((id) => id.includes(":verify"));
      // Refused by the per-address cooldown: today's app-wide count does not move.
      await emails.sendVerificationEmail({
        email: TEACHER,
        url: VERIFY_URL,
        ip: "198.51.100.1",
      });
      await flush();
      const dayRows = async () =>
        (await rows()).filter((id) => id.startsWith("auth-email-day:"));
      expect(await dayRows()).toHaveLength(1);
      await emails.sendVerificationEmail({
        email: TEACHER,
        url: VERIFY_URL,
        ip: "198.51.100.1",
      });
      await flush();
      expect(fake.messages).toHaveLength(1);
      expect(await dayRows()).toHaveLength(1);
      // Use up the rest of the day for verification emails.
      for (let i = 1; i < AUTH_EMAILS_PER_DAY - RESET_EMAIL_RESERVE; i += 1) {
        await emails.sendVerificationEmail({
          email: `orang${String(i)}@example.test`,
          url: VERIFY_URL,
        });
        await flush();
      }
      advance(61);
      // Refused by the app-wide budget: the address's own budgets record nothing.
      const before = await rows();
      await emails.sendVerificationEmail({
        email: "baru@example.test",
        url: VERIFY_URL,
        ip: "198.51.100.1",
      });
      await flush();
      const added = (await rows()).filter((id) => !before.includes(id));
      expect(added).toEqual([]);
      expect(perAddress("baru@example.test").some((id) => before.includes(id))).toBe(
        false,
      );
    },
    DB_TEST_TIMEOUT,
  );

  it.each([
    ["a throwing sender", "throw"],
    ["a failed send", "fail"],
    ["a throwing limiter", "limiter"],
  ] as const)(
    "gives the app-wide reservation back after %s",
    async (_name, mode) => {
      const failing = createFakeEmailSender({ fail: "validation_error" });
      const { t, emails, flush } = await harness({
        sender:
          mode === "throw"
            ? () => Promise.reject(new Error("boom"))
            : mode === "fail"
              ? failing.send
              : undefined,
      });
      await emails.sendVerificationEmail({
        // A value the per-address limiter cannot handle makes it throw.
        email: mode === "limiter" ? (undefined as unknown as string) : TEACHER,
        url: VERIFY_URL,
      });
      await flush();
      const day = (await t.db.select().from(verification)).filter((r) =>
        r.identifier.startsWith("auth-email-day:"),
      );
      expect(day).toEqual([]);
      expect(logger.error).toHaveBeenCalled();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "counts a sent email until the end of the Jakarta day",
    async () => {
      const { t, emails, flush } = await harness();
      await emails.sendVerificationEmail({ email: TEACHER, url: VERIFY_URL });
      await flush();
      const day = (await t.db.select().from(verification)).filter((r) =>
        r.identifier.startsWith("auth-email-day:"),
      );
      // The harness clock is 08:00 UTC on 17 November: 15:00 in Jakarta, the day ends at 17:00 UTC.
      expect(day.map((r) => r.expiresAt.toISOString())).toEqual([
        "2026-11-17T17:00:00.000Z",
      ]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "logs a failed send without the address or the link",
    async () => {
      const failing = createFakeEmailSender({ fail: "validation_error" });
      const { emails, flush } = await harness({ sender: failing.send });
      await emails.sendVerificationEmail({ email: TEACHER, url: VERIFY_URL });
      await flush();
      expect(logger.error).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(vi.mocked(logger.error).mock.calls);
      expect(logged).toContain("validation_error");
      expect(logged).not.toContain(TEACHER);
      expect(logged).not.toContain("tok.en.jwt");
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "sends nothing and logs the error name when the limit cannot be checked",
    async () => {
      const { t, emails, fake, flush } = await harness();
      await t.client.close();
      await emails.sendVerificationEmail({ email: TEACHER, url: VERIFY_URL });
      await flush();
      expect(fake.messages).toEqual([]);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(TEACHER);
    },
    DB_TEST_TIMEOUT,
  );
});
