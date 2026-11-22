import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  account as accountTable,
  session as sessionTable,
  user as userTable,
  verification as verificationTable,
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
  normaliseAuthRequest,
  resetLinkFor,
  RESPONSE_FLOOR_MS,
  type Auth,
} from "./auth-server";
import { CLIENT_IP_HEADER } from "./client-ip";
import { sendLimitPairIdentifier } from "./send-limit";

// Password reset by email link (decision 4) on the real Better Auth 1.7.25 instance against
// PGlite with the real migrations, through auth.handler. Emails are collected by the fake sender
// once the background work is flushed.
const BASE = "http://localhost:3000";
const SECRET = "test-secret-".padEnd(40, "x");
const PASSWORD = "rahasia123";
const NEW_PASSWORD = "baruSekali42";
const MINUTE = 60 * 1000;
const RESET_SUBJECT = "Atur ulang kata sandi MitraMatika";
const RESET_LINK =
  /^http:\/\/localhost:3000\/api\/auth\/reset-password\/([A-Za-z0-9]+)\?callbackURL=%2Freset-password$/;

beforeEach(() => {
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface Harness {
  t: TestDatabase;
  auth: Auth;
  fake: FakeEmailSender;
  /** POST to /api/auth{path}; each call comes from a fresh client IP. */
  /** POST to /api/auth{path}; from a fresh client IP unless `ip` is given. */
  post: (path: string, body: unknown, ip?: string) => Promise<Response>;
  get: (url: string) => Promise<Response>;
  /** Moves the clock of the per-address email limit. */
  advance: (seconds: number) => void;
}

// Response floors are off unless a test sets them, so the suite stays fast.
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
    auth,
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
    get: (url) => send(new Request(url, { headers: { [CLIENT_IP_HEADER]: freshIp() } })),
    advance: (seconds) => {
      clock += seconds * 1000;
    },
  };
}

const userWithEmail = async (t: TestDatabase, email: string) => {
  const rows = await t.db.select().from(userTable).where(eq(userTable.email, email));
  expect(rows).toHaveLength(1);
  return rows[0];
};

const sessionsOf = (t: TestDatabase, userId: string) =>
  t.db.select().from(sessionTable).where(eq(sessionTable.userId, userId));

const sessionCookieOf = (response: Response) =>
  /better-auth\.session_token=[^;]+/.exec(response.headers.get("set-cookie") ?? "")?.[0];

async function codeOf(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { code?: string }).code;
}

const lastMessage = (fake: FakeEmailSender) => fake.messages[fake.messages.length - 1];

/** The reset link of the latest reset email (the whole text is checked by the email tests). */
function resetLinkFrom(fake: FakeEmailSender): { url: string; token: string } {
  const message = lastMessage(fake);
  expect(message.subject).toBe(RESET_SUBJECT);
  const url = /https?:\/\/\S+\/reset-password\/\S+/.exec(message.text)?.[0] ?? "";
  const token = RESET_LINK.exec(url)?.[1];
  expect(token, url).toBeDefined();
  return { url, token: token ?? "" };
}

const signIn = (h: Harness, email: string, password: string) =>
  h.post("/sign-in/email", { email, password });

/** A verified password user: sign up and open the verification link. */
async function verifiedPasswordUser(h: Harness, email: string): Promise<string> {
  await h.post("/sign-up/email", {
    acceptPrivacy: true,
    name: "Bu Guru",
    email,
    password: PASSWORD,
  });
  const link = /https?:\/\/\S+\/verify-email\?\S+/.exec(lastMessage(h.fake).text)?.[0];
  expect(link).toBeDefined();
  await h.get(link ?? "");
  h.advance(60);
  return (await userWithEmail(h.t, email)).id;
}

/** A verified Google user with no password (no credential account). */
async function googleOnlyUser(t: TestDatabase, email: string): Promise<string> {
  const [google] = await t.db
    .insert(userTable)
    .values({ name: "Pak Guru", email, emailVerified: true })
    .returning();
  await t.db.insert(accountTable).values({
    userId: google.id,
    providerId: "google",
    accountId: `google-sub-${email}`,
    updatedAt: new Date(),
  });
  return google.id;
}

const requestReset = (h: Harness, email: string, extra: Record<string, unknown> = {}) =>
  h.post("/request-password-reset", { email, ...extra });

const resetWith = (h: Harness, token: string, newPassword = NEW_PASSWORD) =>
  h.post("/reset-password", { token, newPassword });

describe("password reset by email link", () => {
  it(
    "request reset for a known email sends one email; for an unknown email returns the same response and sends nothing",
    async () => {
      const h = await harness();
      await verifiedPasswordUser(h, "guru@example.test");
      const before = h.fake.messages.length;

      const known = await requestReset(h, "  Guru@Example.TEST ");
      const unknown = await requestReset(h, "nobody@example.test");

      expect(known.status).toBe(200);
      expect(unknown.status).toBe(known.status);
      expect(unknown.headers.get("content-type")).toBe(known.headers.get("content-type"));
      expect(unknown.headers.get("set-cookie")).toBe(known.headers.get("set-cookie"));
      const knownBody: unknown = await known.json();
      expect(await unknown.json()).toEqual(knownBody);

      // One email, to the stored address, with the link to the app's reset page.
      const sent = h.fake.messages.slice(before);
      expect(sent.map((m) => [m.to, m.subject])).toEqual([
        ["guru@example.test", RESET_SUBJECT],
      ]);
      expect(sent[0].text).toContain("60 menit");
      resetLinkFrom(h.fake);
      // The reset route is configured: no "reset password isn't enabled" error any more.
      expect(logger.error).not.toHaveBeenCalled();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "the reset link always leads to the app's reset page, whatever redirect the client asks for",
    async () => {
      const h = await harness();
      await verifiedPasswordUser(h, "guru@example.test");
      const response = await requestReset(h, "guru@example.test", {
        redirectTo: "/somewhere-else",
      });
      expect(response.status).toBe(200);
      const { url, token } = resetLinkFrom(h.fake);
      // The request hook replaced the redirect before Better Auth built its own link: the
      // consistency check in sendResetPassword found the reset page there and logged nothing.
      expect(logger.error).not.toHaveBeenCalled();

      const opened = await h.get(url);
      expect(opened.status).toBe(302);
      expect(opened.headers.get("location")).toBe(
        `${BASE}/reset-password?token=${token}`,
      );
      // Opening the link neither signs in nor uses up the token.
      expect(sessionCookieOf(opened)).toBeUndefined();
      expect((await resetWith(h, token)).status).toBe(200);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a foreign redirect gets the same refusal for a known and an unknown address, and no email",
    async () => {
      const h = await harness();
      await verifiedPasswordUser(h, "guru@example.test");
      const before = h.fake.messages.length;
      const foreign = { redirectTo: "https://evil.example/steal" };
      const known = await requestReset(h, "guru@example.test", foreign);
      const unknown = await requestReset(h, "nobody@example.test", foreign);
      // Better Auth's router checks the raw body before any hook or user lookup (the origin
      // check is on in these tests, as in production).
      expect(known.status).toBe(403);
      expect(unknown.status).toBe(known.status);
      const knownBody = (await known.json()) as { code?: string };
      expect(knownBody.code).toBe("INVALID_REDIRECT_URL");
      expect(await unknown.json()).toEqual(knownBody);
      expect(h.fake.messages.length).toBe(before);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "reset link sets the new password, is single use and expires after 1 h",
    async () => {
      const h = await harness();
      const userId = await verifiedPasswordUser(h, "guru@example.test");
      await requestReset(h, "guru@example.test");
      const { url, token } = resetLinkFrom(h.fake);

      const reset = await resetWith(h, token);
      expect(reset.status).toBe(200);
      expect(await reset.json()).toEqual({ status: true });
      // A reset never signs in by itself.
      expect(sessionCookieOf(reset)).toBeUndefined();
      expect(await sessionsOf(h.t, userId)).toEqual([]);

      expect((await signIn(h, "guru@example.test", PASSWORD)).status).toBe(401);
      expect((await signIn(h, "guru@example.test", NEW_PASSWORD)).status).toBe(200);

      // Single use: neither the reset nor the link work a second time.
      const again = await resetWith(h, token, "lagiLagi777");
      expect(again.status).toBe(400);
      expect(await codeOf(again)).toBe("INVALID_TOKEN");
      const reopened = await h.get(url);
      expect(reopened.headers.get("location")).toBe(
        `${BASE}/reset-password?error=INVALID_TOKEN`,
      );
      expect((await signIn(h, "guru@example.test", NEW_PASSWORD)).status).toBe(200);

      // A made-up token is refused.
      const forged = await resetWith(h, "a".repeat(24));
      expect(await codeOf(forged)).toBe("INVALID_TOKEN");

      // Expiry: a link still opens after 59 minutes and is dead after 61.
      await verifiedPasswordUser(h, "lama@example.test");
      await requestReset(h, "lama@example.test");
      const old = resetLinkFrom(h.fake);
      const start = Date.now();
      vi.useFakeTimers({ toFake: ["Date"] });

      vi.setSystemTime(start + 59 * MINUTE);
      expect((await h.get(old.url)).headers.get("location")).toBe(
        `${BASE}/reset-password?token=${old.token}`,
      );

      vi.setSystemTime(start + 61 * MINUTE);
      expect((await h.get(old.url)).headers.get("location")).toBe(
        `${BASE}/reset-password?error=INVALID_TOKEN`,
      );
      const expired = await resetWith(h, old.token);
      expect(expired.status).toBe(400);
      expect(await codeOf(expired)).toBe("INVALID_TOKEN");
      expect((await signIn(h, "lama@example.test", PASSWORD)).status).toBe(200);
      expect((await signIn(h, "lama@example.test", NEW_PASSWORD)).status).toBe(401);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "stores a reset token only as a hash",
    async () => {
      const h = await harness();
      await verifiedPasswordUser(h, "guru@example.test");
      await requestReset(h, "guru@example.test");
      const { token } = resetLinkFrom(h.fake);
      const rows = await h.t.db.select().from(verificationTable);
      expect(JSON.stringify(rows)).not.toContain(token);
      // The hashed token still works, once.
      expect((await resetWith(h, token)).status).toBe(200);
      expect((await resetWith(h, token, "lagiLagi777")).status).toBe(400);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "applies the password policy to the new password and keeps the token for another try",
    async () => {
      const h = await harness();
      await verifiedPasswordUser(h, "guru@example.test");
      await requestReset(h, "guru@example.test");
      const { token } = resetLinkFrom(h.fake);
      const weak = await resetWith(h, token, "hanyahuruf");
      expect(weak.status).toBe(400);
      expect(await codeOf(weak)).toBe("PASSWORD_NEEDS_LETTER_AND_DIGIT");
      expect((await signIn(h, "guru@example.test", PASSWORD)).status).toBe(200);
      expect((await resetWith(h, token)).status).toBe(200);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a successful reset revokes every existing session of that user",
    async () => {
      const h = await harness();
      const userId = await verifiedPasswordUser(h, "guru@example.test");
      const otherId = await verifiedPasswordUser(h, "lain@example.test");
      const laptop = sessionCookieOf(await signIn(h, "guru@example.test", PASSWORD));
      const phone = sessionCookieOf(await signIn(h, "guru@example.test", PASSWORD));
      const other = sessionCookieOf(await signIn(h, "lain@example.test", PASSWORD));
      // The verification link also opened one session for each user.
      expect(await sessionsOf(h.t, userId)).toHaveLength(3);
      const sessionFor = (cookie: string | undefined) =>
        h.auth.api.getSession({ headers: new Headers({ cookie: cookie ?? "" }) });
      expect((await sessionFor(laptop))?.user.id).toBe(userId);

      await requestReset(h, "guru@example.test");
      expect((await resetWith(h, resetLinkFrom(h.fake).token)).status).toBe(200);

      expect(await sessionsOf(h.t, userId)).toEqual([]);
      expect(await sessionFor(laptop)).toBeNull();
      expect(await sessionFor(phone)).toBeNull();
      // Another user's sessions are untouched.
      expect(await sessionsOf(h.t, otherId)).toHaveLength(2);
      expect((await sessionFor(other))?.user.id).toBe(otherId);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a Google-only user requesting a reset gets the reset email and can then sign in with a password",
    async () => {
      const h = await harness();
      const userId = await googleOnlyUser(h.t, "pak@example.test");
      // Before: no password works.
      expect((await signIn(h, "pak@example.test", NEW_PASSWORD)).status).toBe(401);

      expect((await requestReset(h, "pak@example.test")).status).toBe(200);
      expect(h.fake.messages.map((m) => [m.to, m.subject])).toEqual([
        ["pak@example.test", RESET_SUBJECT],
      ]);
      expect((await resetWith(h, resetLinkFrom(h.fake).token)).status).toBe(200);

      const accounts = await h.t.db
        .select()
        .from(accountTable)
        .where(eq(accountTable.userId, userId));
      expect(accounts.map((a) => a.providerId).sort()).toEqual(["credential", "google"]);
      // Still one user with this address: the reset added a password to it.
      expect((await userWithEmail(h.t, "pak@example.test")).id).toBe(userId);
      const signedIn = await signIn(h, "pak@example.test", NEW_PASSWORD);
      expect(signedIn.status).toBe(200);
      expect(sessionCookieOf(signedIn)).toBeDefined();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a reset of an unverified account neither verifies the email nor signs in",
    async () => {
      const h = await harness();
      // Someone signed up with this address (perhaps not its owner) and never verified it.
      await h.post("/sign-up/email", {
        acceptPrivacy: true,
        name: "Penyerobot",
        email: "guru@example.test",
        password: PASSWORD,
      });
      const userId = (await userWithEmail(h.t, "guru@example.test")).id;
      h.advance(60);

      await requestReset(h, "guru@example.test");
      const { url, token } = resetLinkFrom(h.fake);
      const opened = await h.get(url);
      expect(sessionCookieOf(opened)).toBeUndefined();
      const reset = await resetWith(h, token);
      expect(reset.status).toBe(200);
      expect(sessionCookieOf(reset)).toBeUndefined();

      expect((await userWithEmail(h.t, "guru@example.test")).emailVerified).toBe(false);
      expect(await sessionsOf(h.t, userId)).toEqual([]);
      // The first password is gone; the new one still needs a verified email.
      expect((await signIn(h, "guru@example.test", PASSWORD)).status).toBe(401);
      h.advance(60);
      const unverified = await signIn(h, "guru@example.test", NEW_PASSWORD);
      expect(unverified.status).toBe(403);
      expect(await codeOf(unverified)).toBe("EMAIL_NOT_VERIFIED");
      expect(sessionCookieOf(unverified)).toBeUndefined();

      // Only the verification link (sent again by that sign-in) lets the owner in.
      const verify = /https?:\/\/\S+\/verify-email\?\S+/.exec(
        lastMessage(h.fake).text,
      )?.[0];
      expect(verify).toBeDefined();
      await h.get(verify ?? "");
      expect((await signIn(h, "guru@example.test", NEW_PASSWORD)).status).toBe(200);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "counts reset emails per address and requesting client IP, so one network cannot use up the owner's",
    async () => {
      const h = await harness();
      await verifiedPasswordUser(h, "guru@example.test");
      const attacker = "203.0.113.66";
      const owner = "198.51.100.200";
      const before = h.fake.messages.length;
      for (let i = 0; i < 3; i += 1) {
        expect(
          (
            await h.post(
              "/request-password-reset",
              { email: "guru@example.test" },
              attacker,
            )
          ).status,
        ).toBe(200);
        h.advance(61);
      }
      expect(h.fake.messages.length - before).toBe(3);
      const identifiers = (await h.t.db.select().from(verificationTable)).map(
        (r) => r.identifier,
      );
      const attackerKey = sendLimitPairIdentifier(
        SECRET,
        "reset",
        "guru@example.test",
        attacker,
      );
      expect(identifiers.filter((id) => id === attackerKey)).toHaveLength(3);
      // The owner's request from another network has its own budget and gets through.
      await h.post("/request-password-reset", { email: "guru@example.test" }, owner);
      expect(h.fake.messages.length - before).toBe(4);
      expect(identifiers).not.toContain(
        sendLimitPairIdentifier(SECRET, "reset", "guru@example.test", owner),
      );
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "repeated sign-ups with a victim's address cannot block the victim's reset email",
    async () => {
      const h = await harness();
      await verifiedPasswordUser(h, "guru@example.test");
      const before = h.fake.messages.length;
      // An attacker signs up with the victim's address again and again, from fresh IPs.
      for (let i = 0; i < 10; i += 1) {
        const duplicate = await h.post("/sign-up/email", {
          acceptPrivacy: true,
          name: "Penyerang",
          email: "guru@example.test",
          password: PASSWORD,
        });
        expect(duplicate.status).toBe(200);
        h.advance(61);
      }
      const subjects = () => h.fake.messages.slice(before).map((m) => m.subject);
      expect(subjects()).toEqual(Array(3).fill("Akun MitraMatika kamu sudah ada"));
      expect(h.fake.messages.slice(before).map((m) => m.to)).toEqual(
        Array(3).fill("guru@example.test"),
      );

      await requestReset(h, "guru@example.test");
      expect(subjects()).toEqual([
        ...Array<string>(3).fill("Akun MitraMatika kamu sudah ada"),
        RESET_SUBJECT,
      ]);
      expect((await resetWith(h, resetLinkFrom(h.fake).token)).status).toBe(200);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("the reset link", () => {
  it("is Better Auth's token route with the app's reset page as its callback", () => {
    expect(resetLinkFor("https://mitramatika.example/", "abc123")).toBe(
      "https://mitramatika.example/api/auth/reset-password/abc123?callbackURL=%2Freset-password",
    );
  });

  it("replaces the redirect of every reset request with the app's reset page", () => {
    for (const redirectTo of [
      "/somewhere-else",
      "https://evil.example/steal",
      undefined,
    ]) {
      expect(
        normaliseAuthRequest("/request-password-reset", {
          email: " Guru@Example.TEST ",
          redirectTo,
        }),
      ).toStrictEqual({
        context: { body: { email: "guru@example.test", redirectTo: "/reset-password" } },
      });
    }
    // Other routes keep their fields.
    expect(
      normaliseAuthRequest("/sign-in/email", {
        email: "Guru@example.test",
        callbackURL: "/home",
      }),
    ).toStrictEqual({
      context: { body: { email: "guru@example.test", callbackURL: "/home" } },
    });
  });
});

describe("constant-time reset requests", () => {
  it("holds every /request-password-reset response for at least 800 ms by default", () => {
    expect(RESPONSE_FLOOR_MS["/request-password-reset"]).toBe(800);
  });

  it(
    "known, Google-only, unknown, foreign-redirect and invalid requests all take at least the floor",
    async () => {
      const FLOOR = 300;
      const h = await harness({ responseFloorsMs: { "/request-password-reset": FLOOR } });
      await verifiedPasswordUser(h, "guru@example.test");
      await googleOnlyUser(h.t, "pak@example.test");
      const timed = async (body: unknown) => {
        const start = performance.now();
        const response = await h.post("/request-password-reset", body);
        return {
          status: response.status,
          body: (await response.json()) as unknown,
          ms: performance.now() - start,
        };
      };
      const known = await timed({ email: "guru@example.test" });
      const google = await timed({ email: "pak@example.test" });
      const unknown = await timed({ email: "nobody@example.test" });
      const invalid = await timed({ email: "bukan-email" });
      const evil = "https://evil.example/steal";
      const foreignKnown = await timed({ email: "guru@example.test", redirectTo: evil });
      const foreignUnknown = await timed({
        email: "nobody@example.test",
        redirectTo: evil,
      });

      expect(known.status).toBe(200);
      expect(foreignKnown.status).toBe(403);
      expect(foreignUnknown.status).toBe(403);
      expect(foreignUnknown.body).toEqual(foreignKnown.body);
      for (const outcome of [google, unknown]) {
        expect(outcome.status).toBe(known.status);
        expect(outcome.body).toEqual(known.body);
      }
      expect(invalid.status).toBe(400);
      for (const outcome of [
        known,
        google,
        unknown,
        invalid,
        foreignKnown,
        foreignUnknown,
      ])
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
        new Request(`${BASE}/api/auth/request-password-reset`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: BASE,
            [CLIENT_IP_HEADER]: "198.51.100.250",
          },
          body: JSON.stringify({ email: "nobody@example.test" }),
        }),
      );
      expect(response.status).toBe(200);
      expect(performance.now() - start).toBeGreaterThanOrEqual(799);
    },
    DB_TEST_TIMEOUT,
  );
});
