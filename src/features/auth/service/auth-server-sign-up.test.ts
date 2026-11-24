import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  account as accountTable,
  profiles,
  session as sessionTable,
  user as userTable,
  verification,
} from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { createFakeEmailSender, type FakeEmailSender } from "@/lib/email/fake";
import { logger } from "@/lib/logger";
import {
  createAuth,
  createVerifiedAccountTriggers,
  RATE_LIMIT_RULES,
  RESPONSE_FLOOR_MS,
  USED_AUTH_PATHS,
  withResponseFloors,
} from "./auth-server";
import { CLIENT_IP_HEADER } from "./client-ip";
import {
  SIGN_IN_FAILURE_WINDOW_SECONDS,
  SIGN_IN_FAILURES_PER_ADDRESS,
} from "./sign-in-limit";
import {
  ipDailyIdentifier,
  RESET_REQUESTS_PER_IP_PER_DAY,
  SIGN_UPS_PER_IP_PER_DAY,
  signUpIpIdentifier,
  VERIFICATION_RESENDS_PER_IP_PER_DAY,
} from "./ip-daily-limit";

// Email and password sign-up on the real Better Auth 1.7.25 instance against PGlite with the real
// migrations, through auth.handler (the only path the rate limiter and the app use). Emails are
// collected by the fake sender once the background work is flushed.
const BASE = "http://localhost:3000";
const SECRET = "test-secret-".padEnd(40, "x");
const PASSWORD = "rahasia123";
const HOUR = 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

beforeEach(() => {
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface Harness {
  t: TestDatabase;
  fake: FakeEmailSender;
  /** POST to /api/auth{path}; each call comes from a fresh client IP unless `ip` is given. */
  post: (path: string, body: unknown, ip?: string) => Promise<Response>;
  get: (url: string, ip?: string) => Promise<Response>;
  /** Moves the clock of the per-address email limit. */
  advance: (seconds: number) => void;
}

// The sign-up response floor is off by default here so the suite stays fast; the floor's own
// tests set it.
async function harness(
  options: { responseFloorsMs?: Partial<Record<string, number>> } = {},
): Promise<Harness> {
  const t = await createTestDatabase();
  const fake = createFakeEmailSender();
  const pending: Promise<unknown>[] = [];
  const flush = async () => {
    while (pending.length > 0) await Promise.all(pending.splice(0));
  };
  let clock = Date.now();
  let nextIp = 1;
  const freshIp = () => `198.51.100.${String(nextIp++)}`;
  const auth = createAuth({
    db: t.db,
    secret: SECRET,
    baseURL: BASE,
    google: { clientId: "google-client-id", clientSecret: "google-client-secret" },
    getSender: () => fake.send,
    runInBackground: (task) => {
      pending.push(task);
    },
    now: () => new Date(clock),
    responseFloorsMs: options.responseFloorsMs ?? {},
  });
  const send = async (request: Request) => {
    const response = await auth.handler(request);
    await flush();
    return response;
  };
  return {
    t,
    fake,
    post: (path, body, ip = freshIp()) =>
      send(
        new Request(`${BASE}/api/auth${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: BASE,
            [CLIENT_IP_HEADER]: ip,
          },
          body: JSON.stringify(body),
        }),
      ),
    get: (url, ip = freshIp()) =>
      send(new Request(url, { headers: { [CLIENT_IP_HEADER]: ip } })),
    advance: (seconds) => {
      clock += seconds * 1000;
    },
  };
}

const signUpBody = (email: string, extra: Record<string, unknown> = {}) => ({
  name: "Bu Guru",
  email,
  password: PASSWORD,
  acceptPrivacy: true,
  ...extra,
});

const usersWithEmail = (t: TestDatabase, email: string) =>
  t.db.select().from(userTable).where(eq(userTable.email, email));

const linkFrom = (fake: FakeEmailSender, index = 0) =>
  /https?:\/\/\S+\/verify-email\?\S+/.exec(fake.messages[index]?.text ?? "")?.[0] ?? "";

const sessionCookie = (response: Response) =>
  (response.headers.get("set-cookie") ?? "").includes("better-auth.session_token=");

async function codeOf(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { code?: string }).code;
}

describe("email and password sign-up", () => {
  it(
    "sign-up creates an unverified user and sends one verification email",
    async () => {
      const { t, fake, post } = await harness();
      const response = await post("/sign-up/email", signUpBody("guru@example.test"));
      expect(response.status).toBe(200);
      expect(sessionCookie(response)).toBe(false);
      const body = (await response.json()) as {
        token: unknown;
        user: { email: string; emailVerified: boolean };
      };
      expect(body.token).toBeNull();
      expect(body.user).toMatchObject({
        email: "guru@example.test",
        emailVerified: false,
      });

      const [user] = await usersWithEmail(t, "guru@example.test");
      expect(user.emailVerified).toBe(false);
      const accounts = await t.db
        .select()
        .from(accountTable)
        .where(eq(accountTable.userId, user.id));
      expect(accounts.map((a) => a.providerId)).toEqual(["credential"]);
      expect(accounts[0].password).not.toContain(PASSWORD);
      expect(await t.db.select().from(sessionTable)).toEqual([]);

      expect(fake.messages).toHaveLength(1);
      expect(fake.messages[0].to).toBe("guru@example.test");
      expect(fake.messages[0].subject).toBe("Konfirmasi email akun MitraMatika");
      expect(linkFrom(fake)).toMatch(
        /^http:\/\/localhost:3000\/api\/auth\/verify-email\?/,
      );
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "ignores an emailVerified flag sent by the client",
    async () => {
      const { t, post } = await harness();
      const response = await post(
        "/sign-up/email",
        signUpBody("guru@example.test", { emailVerified: true }),
      );
      expect(response.status).toBe(200);
      const [user] = await usersWithEmail(t, "guru@example.test");
      expect(user.emailVerified).toBe(false);
      expect(await t.db.select().from(sessionTable)).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "sign-in before verification fails with the verify-first error and resends at most once per minute",
    async () => {
      const { fake, post, advance } = await harness();
      await post("/sign-up/email", signUpBody("guru@example.test"));
      expect(fake.messages).toHaveLength(1);

      const signIn = () =>
        post("/sign-in/email", { email: "guru@example.test", password: PASSWORD });
      const first = await signIn();
      expect(first.status).toBe(403);
      expect(await codeOf(first)).toBe("EMAIL_NOT_VERIFIED");
      expect(sessionCookie(first)).toBe(false);
      // Within a minute of the sign-up email: no second email.
      expect(fake.messages).toHaveLength(1);

      advance(60);
      expect((await signIn()).status).toBe(403);
      expect(fake.messages).toHaveLength(2);
      expect((await signIn()).status).toBe(403);
      expect(fake.messages).toHaveLength(2);

      // A wrong password never sends anything.
      advance(60);
      const wrong = await post("/sign-in/email", {
        email: "guru@example.test",
        password: "salah12345",
      });
      expect(wrong.status).toBe(401);
      expect(fake.messages).toHaveLength(2);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "the verification link verifies and signs in",
    async () => {
      const { t, fake, post, get } = await harness();
      await post("/sign-up/email", signUpBody("guru@example.test"));
      const response = await get(linkFrom(fake));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/");
      expect(sessionCookie(response)).toBe(true);
      const [user] = await usersWithEmail(t, "guru@example.test");
      expect(user.emailVerified).toBe(true);
      expect(await t.db.select().from(sessionTable)).toHaveLength(1);

      const signIn = await post("/sign-in/email", {
        email: "guru@example.test",
        password: PASSWORD,
      });
      expect(signIn.status).toBe(200);
      expect(sessionCookie(signIn)).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a verification link opened a second time signs nobody in and starts no session",
    async () => {
      const { t, fake, post, get } = await harness();
      await post("/sign-up/email", signUpBody("guru@example.test"));
      const link = linkFrom(fake);
      expect(sessionCookie(await get(link))).toBe(true);
      expect(await t.db.select().from(sessionTable)).toHaveLength(1);

      // Someone else (or the owner later) opens the same link again, without a session cookie.
      const again = await get(link);
      expect(again.status).toBe(302);
      // Better Auth only redirects to the link's callback ("/" here; in the app
      // /auth/callback?method=email, which shows the "link already used" notice to a visitor
      // without a session, core.ts).
      expect(again.headers.get("location")).toBe("/");
      expect(sessionCookie(again)).toBe(false);
      expect(await t.db.select().from(sessionTable)).toHaveLength(1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a 25-hour-old verification link is rejected (a 23-hour-old one still works)",
    async () => {
      const { t, fake, post, get } = await harness();
      await post("/sign-up/email", signUpBody("old@example.test"));
      await post("/sign-up/email", signUpBody("fresh@example.test"));
      const oldLink = linkFrom(fake, 0);
      const freshLink = linkFrom(fake, 1);
      const start = Date.now();

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(start + 25 * HOUR);
      const expired = await get(oldLink);
      expect(expired.status).toBe(302);
      expect(expired.headers.get("location")).toBe("/?error=TOKEN_EXPIRED");
      expect(sessionCookie(expired)).toBe(false);
      expect((await usersWithEmail(t, "old@example.test"))[0].emailVerified).toBe(false);
      expect(await t.db.select().from(sessionTable)).toEqual([]);

      vi.setSystemTime(start + 23 * HOUR);
      const valid = await get(freshLink);
      expect(sessionCookie(valid)).toBe(true);
      expect((await usersWithEmail(t, "fresh@example.test"))[0].emailVerified).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a forged or tampered verification link is rejected",
    async () => {
      const { t, fake, post, get } = await harness();
      await post("/sign-up/email", signUpBody("guru@example.test"));
      const tampered = linkFrom(fake).replace(/token=([^&]+)/, (_m, token: string) => {
        const [h, p] = token.split(".");
        return `token=${h}.${p}.AAAA`;
      });
      const response = await get(tampered);
      expect(response.headers.get("location")).toBe("/?error=INVALID_TOKEN");
      expect(sessionCookie(response)).toBe(false);
      expect((await usersWithEmail(t, "guru@example.test"))[0].emailVerified).toBe(false);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "duplicate sign-up returns the same response as a new one and sends the account-exists email instead",
    async () => {
      const { t, fake, post } = await harness();
      // An existing, verified Google user.
      const [google] = await t.db
        .insert(userTable)
        .values({ name: "Pak Guru", email: "pak@example.test", emailVerified: true })
        .returning();
      await t.db.insert(accountTable).values({
        userId: google.id,
        providerId: "google",
        accountId: "google-sub-1",
        updatedAt: new Date(),
      });

      const fresh = await post("/sign-up/email", signUpBody("baru@example.test"));
      const duplicate = await post("/sign-up/email", signUpBody("pak@example.test"));

      // Same status, headers and body shape; only the generated id and timestamps differ.
      expect(duplicate.status).toBe(fresh.status);
      expect(duplicate.headers.get("content-type")).toBe(
        fresh.headers.get("content-type"),
      );
      expect(duplicate.headers.get("set-cookie")).toBe(fresh.headers.get("set-cookie"));
      const shape = (value: unknown): unknown =>
        value !== null && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => [k, shape(v)]),
            )
          : value === null
            ? null
            : typeof value;
      const freshBody = (await fresh.json()) as { user: Record<string, unknown> };
      const duplicateBody = (await duplicate.json()) as { user: Record<string, unknown> };
      expect(shape(duplicateBody)).toEqual(shape(freshBody));
      const comparable = ({ user }: { user: Record<string, unknown> }) => ({
        name: user.name,
        emailVerified: user.emailVerified,
        image: user.image,
        idIsUuid: UUID.test(String(user.id)),
        createdIsIso: !Number.isNaN(Date.parse(String(user.createdAt))),
      });
      expect(comparable(duplicateBody)).toEqual(comparable(freshBody));
      expect(duplicateBody.user.email).toBe("pak@example.test");
      expect(duplicateBody.user.id).not.toBe(google.id);

      // The existing user is untouched: one user, still only the Google account, no session.
      expect(await usersWithEmail(t, "pak@example.test")).toHaveLength(1);
      const accounts = await t.db
        .select()
        .from(accountTable)
        .where(eq(accountTable.userId, google.id));
      expect(accounts.map((a) => a.providerId)).toEqual(["google"]);
      expect(await t.db.select().from(sessionTable)).toEqual([]);

      // New address: the verification email. Existing address: the account-exists email.
      expect(fake.messages.map((m) => [m.to, m.subject])).toEqual([
        ["baru@example.test", "Konfirmasi email akun MitraMatika"],
        ["pak@example.test", "Akun MitraMatika Anda sudah ada"],
      ]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a repeated sign-up of an unverified address keeps one user and its first password",
    async () => {
      const { t, fake, post, get } = await harness();
      await post("/sign-up/email", signUpBody("guru@example.test"));
      const again = await post(
        "/sign-up/email",
        signUpBody("guru@example.test", { password: "lainlagi99" }),
      );
      expect(again.status).toBe(200);
      expect(await usersWithEmail(t, "guru@example.test")).toHaveLength(1);
      expect(fake.messages.map((m) => m.subject)).toEqual([
        "Konfirmasi email akun MitraMatika",
        "Akun MitraMatika Anda sudah ada",
      ]);
      await get(linkFrom(fake));
      expect(
        (
          await post("/sign-in/email", {
            email: "guru@example.test",
            password: "lainlagi99",
          })
        ).status,
      ).toBe(401);
      expect(
        (await post("/sign-in/email", { email: "guru@example.test", password: PASSWORD }))
          .status,
      ).toBe(200);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "email is stored lower-cased and trimmed, and every email route treats variants as one address",
    async () => {
      const { t, fake, post, get } = await harness();
      const response = await post(
        "/sign-up/email",
        signUpBody("  Guru.Baru@Example.TEST "),
      );
      expect(response.status).toBe(200);
      expect(await usersWithEmail(t, "guru.baru@example.test")).toHaveLength(1);

      await post("/sign-up/email", signUpBody(" GURU.BARU@example.test"));
      expect(await t.db.select().from(userTable)).toHaveLength(3); // two harness users + one
      expect(fake.messages.map((m) => m.to)).toEqual([
        "guru.baru@example.test",
        "guru.baru@example.test",
      ]);

      await get(linkFrom(fake));
      const signIn = await post("/sign-in/email", {
        email: " GURU.baru@EXAMPLE.test ",
        password: PASSWORD,
      });
      expect(signIn.status).toBe(200);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "resending verification answers the same for a known and an unknown address",
    async () => {
      const { fake, post, advance } = await harness();
      await post("/sign-up/email", signUpBody("guru@example.test"));
      advance(60);
      const known = await post("/send-verification-email", {
        email: " Guru@Example.test ",
      });
      const unknown = await post("/send-verification-email", {
        email: "nobody@example.test",
      });
      expect(known.status).toBe(200);
      expect(unknown.status).toBe(known.status);
      expect(await unknown.json()).toEqual(await known.json());
      expect(fake.messages.map((m) => m.to)).toEqual([
        "guru@example.test",
        "guru@example.test",
      ]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "applies the password policy on the server",
    async () => {
      const { t, fake, post } = await harness();
      for (const [password, code] of [
        ["abcdefghij", "PASSWORD_NEEDS_LETTER_AND_DIGIT"],
        ["1234567890", "PASSWORD_NEEDS_LETTER_AND_DIGIT"],
        ["abc1234", "PASSWORD_TOO_SHORT"],
        [`a1${"x".repeat(127)}`, "PASSWORD_TOO_LONG"],
      ] as const) {
        const response = await post(
          "/sign-up/email",
          signUpBody("lemah@example.test", { password }),
        );
        expect(response.status, password).toBe(400);
        expect(await codeOf(response), password).toBe(code);
      }
      expect(await usersWithEmail(t, "lemah@example.test")).toEqual([]);
      expect(fake.messages).toEqual([]);

      const reset = await post("/reset-password", {
        newPassword: "abcdefghij",
        token: "anything",
      });
      expect(reset.status).toBe(400);
      expect(await codeOf(reset)).toBe("PASSWORD_NEEDS_LETTER_AND_DIGIT");
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "rejects a name outside 2 to 80 characters and a school name over 120",
    async () => {
      const { t, post } = await harness();
      for (const extra of [
        { name: " a " },
        { name: "x".repeat(81) },
        { schoolName: "s".repeat(121) },
        { schoolName: 42 },
      ]) {
        const response = await post(
          "/sign-up/email",
          signUpBody("guru@example.test", extra),
        );
        expect(response.status, JSON.stringify(extra)).toBe(400);
        expect(await codeOf(response)).toBe("INVALID_SIGN_UP");
      }
      expect(await usersWithEmail(t, "guru@example.test")).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "profile row stores display name and school name from the sign-up",
    async () => {
      const { t, post } = await harness();
      await post(
        "/sign-up/email",
        signUpBody("guru@example.test", {
          name: "  Bu Guru  ",
          schoolName: " SMP Negeri 1 Bandung ",
        }),
      );
      await post("/sign-up/email", signUpBody("tanpa@example.test"));
      const [user] = await usersWithEmail(t, "guru@example.test");
      expect(user.name).toBe("Bu Guru");
      const rows = await t.db.select().from(profiles).where(eq(profiles.id, user.id));
      expect(rows.map((r) => [r.displayName, r.schoolName])).toEqual([
        ["Bu Guru", "SMP Negeri 1 Bandung"],
      ]);
      const [other] = await usersWithEmail(t, "tanpa@example.test");
      const otherRows = await t.db
        .select()
        .from(profiles)
        .where(eq(profiles.id, other.id));
      expect(otherRows.map((r) => r.schoolName)).toEqual([null]);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("rate limits on the email routes", () => {
  const cases: [string, unknown][] = [
    ["/sign-up/email", signUpBody("rate@example.test")],
    ["/sign-in/email", { email: "rate@example.test", password: PASSWORD }],
    ["/request-password-reset", { email: "rate@example.test", redirectTo: "/" }],
    ["/reset-password", { newPassword: PASSWORD, token: "x" }],
    ["/send-verification-email", { email: "rate@example.test" }],
  ];

  it.each(cases)(
    "%s answers 429 after its per-IP limit",
    async (path, body) => {
      const { post } = await harness();
      const { max } = RATE_LIMIT_RULES[path];
      const ip = "203.0.113.200";
      for (let i = 0; i < max; i += 1) {
        expect((await post(path, body, ip)).status, `${path} #${String(i)}`).not.toBe(
          429,
        );
      }
      expect((await post(path, body, ip)).status).toBe(429);
      expect((await post(path, body, "203.0.113.201")).status).not.toBe(429);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses sign-up from an IP after 10 attempts in 24 hours, whatever the address, with 429 TOO_MANY_ATTEMPTS",
    async () => {
      const { t, post, fake, advance } = await harness();
      const ip = "203.0.113.210";
      // Nine earlier attempts from this IP today (seeded: Better Auth's own limit is 3 a minute).
      const at = Date.now();
      await t.db.insert(verification).values(
        Array.from({ length: SIGN_UPS_PER_IP_PER_DAY - 1 }, () => ({
          identifier: signUpIpIdentifier(SECRET, ip),
          value: "1",
          expiresAt: new Date(at + 23 * HOUR),
        })),
      );
      expect(
        (await post("/sign-up/email", signUpBody("ke10@example.test"), ip)).status,
      ).toBe(200);
      const refused = await post("/sign-up/email", signUpBody("ke11@example.test"), ip);
      expect(refused.status).toBe(429);
      expect(((await refused.json()) as { code?: string }).code).toBe(
        "TOO_MANY_ATTEMPTS",
      );
      expect(await usersWithEmail(t, "ke11@example.test")).toEqual([]);
      expect(fake.messages.map((m) => m.to)).toEqual(["ke10@example.test"]);
      // Another IP is unaffected; the stored key is a hash, never the IP.
      expect(
        (await post("/sign-up/email", signUpBody("lain@example.test"), "203.0.113.211"))
          .status,
      ).toBe(200);
      const identifiers = (await t.db.select().from(verification)).map(
        (r) => r.identifier,
      );
      expect(identifiers.join(" ")).not.toContain(ip);
      // A day later the IP may sign up again.
      advance(24 * 60 * 60);
      expect(
        (await post("/sign-up/email", signUpBody("besok@example.test"), ip)).status,
      ).toBe(200);
    },
    DB_TEST_TIMEOUT,
  );

  it.each([
    ["/request-password-reset", RESET_REQUESTS_PER_IP_PER_DAY],
    ["/send-verification-email", VERIFICATION_RESENDS_PER_IP_PER_DAY],
  ] as const)(
    "%s is capped per IP per day too, so one network cannot drain the app-wide email budget",
    async (path, max) => {
      const { t, post } = await harness();
      const ip = "203.0.113.220";
      await t.db.insert(verification).values(
        Array.from({ length: max }, () => ({
          identifier: ipDailyIdentifier(SECRET, path, ip),
          value: "1",
          expiresAt: new Date(Date.now() + 23 * HOUR),
        })),
      );
      const refused = await post(path, { email: "siapa@example.test" }, ip);
      expect(refused.status).toBe(429);
      expect(((await refused.json()) as { code?: string }).code).toBe(
        "TOO_MANY_ATTEMPTS",
      );
      expect(
        (await post(path, { email: "siapa@example.test" }, "203.0.113.221")).status,
      ).toBe(200);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "counts the verification email a sign-in resends against the same per-IP daily resend cap",
    async () => {
      const { t, post, fake, advance } = await harness();
      await post("/sign-up/email", signUpBody("belum@example.test"));
      expect(fake.messages).toHaveLength(1);
      advance(61);
      const ip = "203.0.113.230";
      await t.db.insert(verification).values(
        Array.from({ length: VERIFICATION_RESENDS_PER_IP_PER_DAY }, () => ({
          identifier: ipDailyIdentifier(SECRET, "/send-verification-email", ip),
          value: "1",
          expiresAt: new Date(Date.now() + 23 * HOUR),
        })),
      );
      const capped = await post(
        "/sign-in/email",
        { email: "belum@example.test", password: PASSWORD },
        ip,
      );
      // The answer is unchanged; only the email is not sent.
      expect(capped.status).toBe(403);
      expect(await codeOf(capped)).toBe("EMAIL_NOT_VERIFIED");
      expect(fake.messages).toHaveLength(1);
      // From another network the resend goes out.
      await post(
        "/sign-in/email",
        { email: "belum@example.test", password: PASSWORD },
        "203.0.113.231",
      );
      expect(fake.messages).toHaveLength(2);
    },
    DB_TEST_TIMEOUT,
  );

  it("every used path except the error and health pages has an explicit rule", () => {
    const covered = (path: string) =>
      Object.keys(RATE_LIMIT_RULES).some(
        (rule) =>
          rule === path || (rule.endsWith("/*") && path.startsWith(rule.slice(0, -1))),
      );
    const uncovered = USED_AUTH_PATHS.map((path) => path.replace(/:\w+$/, "x")).filter(
      (path) => !covered(path),
    );
    expect(uncovered).toEqual(["/error", "/ok"]);
  });
});

describe("direct sign-up bodies (final review M1)", () => {
  it(
    "refuses a sign-up without acceptPrivacy: true, before anything is written",
    async () => {
      const { t, post, fake } = await harness();
      for (const acceptPrivacy of [undefined, false, "true"]) {
        const body: Record<string, unknown> = signUpBody("tanpa-izin@example.test");
        body.acceptPrivacy = acceptPrivacy;
        const response = await post("/sign-up/email", body);
        expect(response.status).toBe(400);
        expect(await codeOf(response)).toBe("INVALID_SIGN_UP");
      }
      expect(await usersWithEmail(t, "tanpa-izin@example.test")).toEqual([]);
      expect(fake.messages).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses an address longer than 254 characters on every route that takes one",
    async () => {
      const { post } = await harness();
      const long = `${"a".repeat(64)}@${"b".repeat(186)}.test`;
      expect(long.length).toBe(256);
      for (const [path, body] of [
        ["/sign-up/email", signUpBody(long)],
        ["/sign-in/email", { email: long, password: PASSWORD }],
        ["/request-password-reset", { email: long }],
        ["/send-verification-email", { email: long }],
      ] as const) {
        const response = await post(path, body);
        expect(response.status, path).toBe(400);
        expect(await codeOf(response), path).toBe("INVALID_EMAIL");
      }
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "never stores an image sent in the sign-up body",
    async () => {
      const { t, post } = await harness();
      await post(
        "/sign-up/email",
        signUpBody("gambar@example.test", { image: "https://evil.example/x.png" }),
      );
      const [user] = await usersWithEmail(t, "gambar@example.test");
      expect(user.image).toBeNull();
    },
    DB_TEST_TIMEOUT,
  );
});

describe("password sign-in failures per address", () => {
  // Each attempt comes from a fresh client IP: a distributed guess that the per-IP limit cannot
  // see.
  async function verifiedUser(h: Harness, email: string) {
    await h.post("/sign-up/email", signUpBody(email));
    await h.get(linkFrom(h.fake, h.fake.messages.length - 1));
  }
  const signIn = (h: Harness, email: string, password: string) =>
    h.post("/sign-in/email", { email, password });

  it("allows 10 failures per address in 15 minutes", () => {
    expect(SIGN_IN_FAILURES_PER_ADDRESS).toBe(10);
    expect(SIGN_IN_FAILURE_WINDOW_SECONDS).toBe(15 * 60);
  });

  it(
    "refuses the address after 10 failures from different IPs, even with the right password, until the window ends",
    async () => {
      const h = await harness();
      await verifiedUser(h, "guru@example.test");
      for (let i = 0; i < SIGN_IN_FAILURES_PER_ADDRESS; i += 1) {
        expect((await signIn(h, "guru@example.test", `salah${String(i)}x`)).status).toBe(
          401,
        );
      }
      const refused = await signIn(h, "guru@example.test", "salah99x");
      expect(refused.status).toBe(429);
      expect(await codeOf(refused)).toBe("TOO_MANY_ATTEMPTS");
      const right = await signIn(h, " Guru@Example.TEST ", PASSWORD);
      expect(right.status).toBe(429);
      expect(sessionCookie(right)).toBe(false);
      // Another address is unaffected.
      expect((await signIn(h, "lain@example.test", PASSWORD)).status).toBe(401);
      h.advance(15 * 60);
      expect((await signIn(h, "guru@example.test", PASSWORD)).status).toBe(200);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "answers an unknown address exactly like a known one",
    async () => {
      const h = await harness();
      for (let i = 0; i < SIGN_IN_FAILURES_PER_ADDRESS; i += 1) {
        expect(
          (await signIn(h, "tidakada@example.test", `salah${String(i)}x`)).status,
        ).toBe(401);
      }
      const refused = await signIn(h, "tidakada@example.test", PASSWORD);
      expect(refused.status).toBe(429);
      expect(await codeOf(refused)).toBe("TOO_MANY_ATTEMPTS");
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "does not count successful sign-ins, and stores no address",
    async () => {
      const h = await harness();
      await verifiedUser(h, "guru@example.test");
      for (let i = 0; i < SIGN_IN_FAILURES_PER_ADDRESS + 2; i += 1) {
        expect((await signIn(h, "guru@example.test", PASSWORD)).status).toBe(200);
      }
      expect((await signIn(h, "guru@example.test", "salah1x")).status).toBe(401);
      const identifiers = (await h.t.db.select().from(verification)).map(
        (r) => r.identifier,
      );
      expect(identifiers.filter((id) => id.startsWith("sign-in-failure:"))).toHaveLength(
        1,
      );
      expect(identifiers.join(" ")).not.toContain("guru@example.test");
    },
    DB_TEST_TIMEOUT,
  );
});

describe("constant-time sign-up responses", () => {
  it("holds every /sign-up/email response for at least 800 ms by default", () => {
    expect(RESPONSE_FLOOR_MS["/sign-up/email"]).toBe(800);
  });

  it(
    "new, duplicate and refused sign-ups all take at least the floor",
    async () => {
      const FLOOR = 300;
      const { t, post } = await harness({
        responseFloorsMs: { "/sign-up/email": FLOOR },
      });
      await t.db
        .insert(userTable)
        .values({ name: "Pak Guru", email: "pak@example.test", emailVerified: true });
      const timed = async (body: unknown) => {
        const start = performance.now();
        const response = await post("/sign-up/email", body);
        return { status: response.status, ms: performance.now() - start };
      };
      const outcomes = [
        await timed(signUpBody("baru@example.test")),
        await timed(signUpBody("pak@example.test")),
        await timed(signUpBody("lemah@example.test", { password: "abcdefghij" })),
        await timed(signUpBody("pak@example.test", { password: "abcdefghij" })),
        await timed(signUpBody("baru2@example.test", { name: "x" })),
        await timed({ email: "bukan-email" }),
      ];
      expect(outcomes.map((o) => o.status)).toEqual([200, 200, 400, 400, 400, 400]);
      for (const outcome of outcomes)
        // Timers can fire a little early and the clock is read before and after the call, so a
        // measured 298.9 ms is a 300 ms floor; 10 ms of slack still separates it from no floor.
        expect(outcome.ms).toBeGreaterThanOrEqual(FLOOR - 10);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "applies the default floor when none is configured",
    async () => {
      const t = await createTestDatabase();
      const auth = createAuth({
        db: t.db,
        secret: SECRET,
        baseURL: BASE,
        google: null,
        getSender: () => createFakeEmailSender().send,
        runInBackground: () => undefined,
      });
      const start = performance.now();
      const response = await auth.handler(
        new Request(`${BASE}/api/auth/sign-up/email`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: BASE,
            [CLIENT_IP_HEADER]: "198.51.100.250",
          },
          body: JSON.stringify(signUpBody("guru@example.test")),
        }),
      );
      expect(response.status).toBe(200);
      expect(performance.now() - start).toBeGreaterThanOrEqual(799);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("withResponseFloors", () => {
  function setup(handlerMs: number, outcome: "resolve" | "reject" = "resolve") {
    let clock = 0;
    const events: string[] = [];
    const sleep = vi.fn((ms: number) => {
      events.push(`sleep ${String(ms)}`);
      clock += ms;
      return Promise.resolve();
    });
    const handler = (request: Request) => {
      clock += handlerMs;
      events.push(`handled ${new URL(request.url).pathname}`);
      return outcome === "resolve"
        ? Promise.resolve(new Response("ok"))
        : Promise.reject(new Error("boom"));
    };
    const wrapped = withResponseFloors(handler, {
      basePath: "/api/auth",
      floorsMs: { "/sign-up/email": 800 },
      now: () => clock,
      sleep,
    });
    const call = (path: string) =>
      wrapped(new Request(`${BASE}${path}`, { method: "POST" }));
    return { call, sleep, events, clock: () => clock };
  }

  it("waits out the rest of the floor after the handler has answered", async () => {
    const { call, events, clock } = setup(120);
    expect(await (await call("/api/auth/sign-up/email")).text()).toBe("ok");
    // The handler (and its database work) is done before the wait starts.
    expect(events).toEqual(["handled /api/auth/sign-up/email", "sleep 680"]);
    expect(clock()).toBe(800);
  });

  it("does not wait when the handler already took longer than the floor", async () => {
    const { call, sleep } = setup(950);
    await call("/api/auth/sign-up/email");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("also holds a failed request for the floor, then rethrows", async () => {
    const { call, events } = setup(50, "reject");
    await expect(call("/api/auth/sign-up/email")).rejects.toThrow("boom");
    expect(events).toEqual(["handled /api/auth/sign-up/email", "sleep 750"]);
  });

  it("leaves every other path alone", async () => {
    const { call, sleep } = setup(10);
    for (const path of [
      "/api/auth/sign-in/email",
      "/api/auth/sign-up/email/x",
      "/sign-up/email",
    ]) {
      await call(path);
    }
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("the admin notice trigger (ADR-0022, hook: databaseHooks.user.update.after on /verify-email)", () => {
  const ADMIN = "admin@example.test";
  const toAdmin = (fake: FakeEmailSender) =>
    fake.messages.filter((m) => m.subject.startsWith("Akun baru menunggu"));

  it(
    "mere sign-up sends no notice; opening the verification link sends exactly one, even twice",
    async () => {
      vi.stubEnv("ADMIN_EMAIL", ADMIN);
      const { fake, post, get } = await harness();
      await post(
        "/sign-up/email",
        signUpBody("guru@example.test", { schoolName: "SMP 9" }),
      );
      expect(toAdmin(fake)).toEqual([]);
      const link = linkFrom(fake);
      expect(sessionCookie(await get(link))).toBe(true);
      expect(toAdmin(fake)).toHaveLength(1);
      expect(toAdmin(fake)[0].subject).toBe(
        "Akun baru menunggu persetujuan di MitraMatika",
      );
      expect(toAdmin(fake)[0].text).toContain("guru@example.test");
      expect(toAdmin(fake)[0].text).toContain("SMP 9");
      await get(link);
      expect(toAdmin(fake)).toHaveLength(1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "an account whose address is the admin's own (approved) is verified without a notice",
    async () => {
      vi.stubEnv("ADMIN_EMAIL", ADMIN);
      const { t, fake, post, get } = await harness();
      await post("/sign-up/email", signUpBody(ADMIN));
      await get(linkFrom(fake));
      expect(toAdmin(fake)).toEqual([]);
      const [user] = await usersWithEmail(t, ADMIN);
      const [profile] = await t.db
        .select()
        .from(profiles)
        .where(eq(profiles.id, user.id));
      expect(profile.adminNotifiedAt).toBeInstanceOf(Date);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "without ADMIN_EMAIL nothing is sent and the response is unchanged",
    async () => {
      const { fake, post, get } = await harness();
      await post("/sign-up/email", signUpBody("guru@example.test"));
      const response = await get(linkFrom(fake));
      expect(response.status).toBe(302);
      expect(fake.messages).toHaveLength(1);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("createVerifiedAccountTriggers", () => {
  it("schedules only on /verify-email updates, non-sign-up creations and Google links", async () => {
    const scheduled: string[] = [];
    const triggers = createVerifiedAccountTriggers((id) => scheduled.push(id));
    // Other user updates (a name change, another endpoint, no endpoint) schedule nothing.
    await triggers.userUpdated(
      { id: "u1", emailVerified: true },
      { path: "/update-user" },
    );
    await triggers.userUpdated({ id: "u2", emailVerified: true }, null);
    await triggers.userUpdated(
      { id: "u3", emailVerified: false },
      { path: "/verify-email" },
    );
    // The email sign-up creates an unverified user: nothing.
    await triggers.userCreated(
      { id: "u4", emailVerified: false },
      { path: "/sign-up/email" },
    );
    await triggers.userCreated(
      { id: "u5", emailVerified: true },
      { path: "/sign-up/email" },
    );
    await triggers.accountCreated({ providerId: "credential", userId: "u6" });
    expect(scheduled).toEqual([]);
    await triggers.userUpdated(
      { id: "u7", emailVerified: true },
      { path: "/verify-email" },
    );
    await triggers.userCreated(
      { id: "u8", emailVerified: true },
      { path: "/callback/:id" },
    );
    await triggers.accountCreated({ providerId: "google", userId: "u9" });
    expect(scheduled).toEqual(["u7", "u8", "u9"]);
  });

  it("never throws when scheduling does", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const triggers = createVerifiedAccountTriggers(() => {
      throw new Error("boom");
    });
    await expect(
      triggers.userUpdated({ id: "u1", emailVerified: true }, { path: "/verify-email" }),
    ).resolves.toBeUndefined();
  });
});
