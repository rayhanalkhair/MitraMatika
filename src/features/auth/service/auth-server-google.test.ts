import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  account as accountTable,
  profiles,
  session as sessionTable,
  user as userTable,
} from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { createFakeEmailSender, type FakeEmailSender } from "@/lib/email/fake";
import { logger } from "@/lib/logger";
import { createAuth, type Auth } from "./auth-server";
import { CLIENT_IP_HEADER } from "./client-ip";

// Google sign-in and account linking (decision 5) on the real Better Auth 1.7.25 instance against
// PGlite with the real migrations, through auth.handler: /sign-in/social starts the flow, and
// /callback/google finishes it. The only fake is Google's token endpoint: global fetch answers it
// with an id_token carrying the test profile (on the code flow Better Auth reads the profile from
// that id_token, which it trusts because it came from the token endpoint over TLS).
const BASE = "http://localhost:3000";
const SECRET = "test-secret-".padEnd(40, "x");
const GOOGLE_CLIENT_ID = "google-client-id";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CALLBACK_PAGE = "/auth/callback";
const PASSWORD = "rahasia123";
const ATTACKER_PASSWORD = "penyusup99";
const NEW_PASSWORD = "baruSekali42";
const VICTIM = "korban@example.test";
const RESET_SUBJECT = "Atur ulang kata sandi MitraMatika";
const ACCOUNT_EXISTS_SUBJECT_PATTERN = /akun/i;

beforeEach(() => {
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface GoogleProfile {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
}

interface Harness {
  t: TestDatabase;
  auth: Auth;
  fake: FakeEmailSender;
  /** POST to /api/auth{path}; each call comes from a fresh client IP. */
  post: (path: string, body: unknown) => Promise<Response>;
  get: (url: string, headers?: Record<string, string>) => Promise<Response>;
  /** The whole Google round trip; the answer is the callback's redirect. */
  google: (profile: GoogleProfile) => Promise<Response>;
  /** Moves the clock of the per-address email limit. */
  advance: (seconds: number) => void;
}

const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** An id_token as Google's token endpoint returns it (the signature is never checked there). */
function idTokenFor(profile: GoogleProfile): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    encode({ alg: "RS256", kid: "test-key", typ: "JWT" }),
    encode({
      iss: "https://accounts.google.com",
      aud: GOOGLE_CLIENT_ID,
      iat: now,
      exp: now + 3600,
      name: "Pengguna Google",
      ...profile,
    }),
    "signature",
  ].join(".");
}

/** Every cookie a response sets, as one Cookie request header. */
const cookieHeaderOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

const sessionCookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .find((cookie) => cookie.startsWith("better-auth.session_token="));

type Fn = (...args: unknown[]) => unknown;

/** `target`, with the method `prop` replaced by `make(original)`; every method stays bound. */
function overriding<T extends object>(
  target: T,
  prop: string,
  make: (original: Fn) => Fn,
): T {
  return new Proxy(target, {
    get(object, key) {
      const value: unknown = Reflect.get(object, key, object);
      if (typeof value !== "function") return value;
      const bound: Fn = (value as Fn).bind(object);
      return key === prop ? make(bound) : bound;
    },
  });
}

/**
 * The database as Better Auth sees it, with one pause: right after the first `user` row insert
 * returns (inside a transaction or not), `afterUserInsert` runs before the writer continues. The
 * email and password sign-up writes the user row and then its password (credential account) row,
 * so this is the moment between the two.
 */
function pauseAfterUserInsert(
  db: TestDatabase["db"],
  afterUserInsert: () => Promise<void>,
): TestDatabase["db"] {
  let fired = false;
  const wrap = <T extends object>(target: T): T =>
    overriding(
      overriding(
        target,
        "transaction",
        (original) =>
          (callback, ...rest) =>
            original((tx: object) => (callback as Fn)(wrap(tx)), ...rest),
      ),
      "insert",
      (original) => (table) => {
        const builder = original(table) as object;
        if (table !== userTable) return builder;
        return overriding(
          builder,
          "values",
          (values) =>
            (...args) =>
              overriding(
                values(...args) as object,
                "returning",
                (returning) =>
                  (...more) =>
                    (returning(...more) as PromiseLike<unknown>).then(async (rows) => {
                      if (!fired) {
                        fired = true;
                        await afterUserInsert();
                      }
                      return rows;
                    }),
              ),
        );
      },
    );
  return wrap(db);
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

async function harness(
  options: { wrapDb?: (db: TestDatabase["db"]) => TestDatabase["db"] } = {},
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
    db: options.wrapDb ? options.wrapDb(t.db) : t.db,
    secret: SECRET,
    baseURL: BASE,
    google: { clientId: GOOGLE_CLIENT_ID, clientSecret: "google-client-secret" },
    getSender: () => fake.send,
    runInBackground: (task) => {
      pending.push(task);
    },
    now: () => new Date(clock),
    responseFloorsMs: {},
  });
  const send = async (request: Request) => {
    const response = await auth.handler(request);
    await flush();
    return response;
  };
  const post = (path: string, body: unknown) =>
    send(
      new Request(`${BASE}/api/auth${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE,
          [CLIENT_IP_HEADER]: freshIp(),
        },
        body: JSON.stringify(body),
      }),
    );
  const get = (url: string, headers: Record<string, string> = {}) =>
    send(new Request(url, { headers: { ...headers, [CLIENT_IP_HEADER]: freshIp() } }));

  const google = async (profile: GoogleProfile) => {
    const start = await post("/sign-in/social", {
      provider: "google",
      callbackURL: CALLBACK_PAGE,
    });
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    const state = new URL(url).searchParams.get("state") ?? "";
    expect(state).not.toBe("");

    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const target = input instanceof Request ? input.url : String(input);
        if (target !== GOOGLE_TOKEN_ENDPOINT) {
          return Promise.reject(new Error(`unexpected fetch: ${target}`));
        }
        return Promise.resolve(
          Response.json({
            access_token: `access-${profile.sub}`,
            id_token: idTokenFor(profile),
            token_type: "Bearer",
            expires_in: 3600,
            scope: "openid email profile",
          }),
        );
      }),
    );
    try {
      return await get(
        `${BASE}/api/auth/callback/google?code=code-${profile.sub}&state=${encodeURIComponent(state)}`,
        { cookie: cookieHeaderOf(start) },
      );
    } finally {
      vi.unstubAllGlobals();
    }
  };

  return {
    t,
    auth,
    fake,
    post,
    get,
    google,
    advance: (seconds) => {
      clock += seconds * 1000;
    },
  };
}

const usersWithEmail = (t: TestDatabase, email: string) =>
  t.db.select().from(userTable).where(eq(userTable.email, email));

const allUsersExceptSeed = async (t: TestDatabase) =>
  (await t.db.select().from(userTable)).filter(
    (user) => !["a@example.test", "b@example.test"].includes(user.email),
  );

async function onlyUserWithEmail(t: TestDatabase, email: string) {
  const rows = await usersWithEmail(t, email);
  expect(rows).toHaveLength(1);
  return rows[0];
}

const providersOf = async (t: TestDatabase, userId: string) =>
  (await t.db.select().from(accountTable).where(eq(accountTable.userId, userId)))
    .map((account) => account.providerId)
    .sort();

const sessionsOf = (t: TestDatabase, userId: string) =>
  t.db.select().from(sessionTable).where(eq(sessionTable.userId, userId));

const lastMessage = (fake: FakeEmailSender) => fake.messages[fake.messages.length - 1];

const signIn = (h: Harness, email: string, password: string) =>
  h.post("/sign-in/email", { email, password });

async function codeOf(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { code?: string }).code;
}

/** The redirect target of a callback answer, relative to the app. */
function locationOf(response: Response): string {
  expect(response.status).toBe(302);
  return response.headers.get("location") ?? "";
}

/** A successful Google sign-in: back to the app's callback page with a session cookie. */
async function expectSignedIn(h: Harness, response: Response, userId: string) {
  expect(locationOf(response)).toMatch(/^(http:\/\/localhost:3000)?\/auth\/callback$/);
  const cookie = sessionCookieOf(response);
  expect(cookie).toBeDefined();
  const session = await h.auth.api.getSession({
    headers: new Headers({ cookie: cookie ?? "" }),
  });
  expect(session?.user.id).toBe(userId);
}

/** A refused Google sign-in: Better Auth's error page, and no session cookie. */
function expectErrorPage(response: Response) {
  expect(locationOf(response)).toMatch(
    /^http:\/\/localhost:3000\/api\/auth\/error\?error=/,
  );
  expect(sessionCookieOf(response)).toBeUndefined();
}

/** Sign up with a password; the address stays unverified until the link is opened. */
async function unverifiedPasswordUser(h: Harness, email: string, password: string) {
  expect(
    (
      await h.post("/sign-up/email", {
        acceptPrivacy: true,
        name: "Penyusup",
        email,
        password,
      })
    ).status,
  ).toBe(200);
  const user = await onlyUserWithEmail(h.t, email);
  expect(user.emailVerified).toBe(false);
  h.advance(60);
  return user.id;
}

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
  const user = await onlyUserWithEmail(h.t, email);
  expect(user.emailVerified).toBe(true);
  return user.id;
}

/** Request a reset for the address and set NEW_PASSWORD with the emailed link. */
async function resetPassword(h: Harness, email: string) {
  expect((await h.post("/request-password-reset", { email })).status).toBe(200);
  const message = lastMessage(h.fake);
  expect(message.subject).toBe(RESET_SUBJECT);
  const token = /\/reset-password\/([A-Za-z0-9]+)\?/.exec(message.text)?.[1];
  expect(token).toBeDefined();
  expect(
    (await h.post("/reset-password", { token, newPassword: NEW_PASSWORD })).status,
  ).toBe(200);
}

describe("Google sign-in and account linking (decision 5)", () => {
  it(
    "links by Google's verified email only: no trusted provider, never across different emails",
    async () => {
      const h = await harness();
      const context = await h.auth.$context;
      // A trusted provider would link even when Google reports the email unverified.
      expect(context.trustedProviders).toEqual([]);
      expect(context.options.account.accountLinking).toStrictEqual({
        enabled: true,
        disableImplicitLinking: false,
        requireLocalEmailVerified: false,
        allowDifferentEmails: false,
        updateUserInfoOnLink: false,
      });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "Google sign-in with a new email creates one verified user",
    async () => {
      const h = await harness();
      const response = await h.google({
        sub: "sub-new",
        email: "baru@example.test",
        email_verified: true,
        name: "Pak Baru",
      });

      const user = await onlyUserWithEmail(h.t, "baru@example.test");
      expect(user.emailVerified).toBe(true);
      expect(user.name).toBe("Pak Baru");
      expect(await allUsersExceptSeed(h.t)).toHaveLength(1);
      expect(await providersOf(h.t, user.id)).toEqual(["google"]);
      expect(await sessionsOf(h.t, user.id)).toHaveLength(1);
      await expectSignedIn(h, response, user.id);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "Google sign-in with the email of a verified password user links to that same user (one user row, two account rows)",
    async () => {
      const h = await harness();
      const userId = await verifiedPasswordUser(h, "guru@example.test");

      const response = await h.google({
        sub: "sub-guru",
        email: "guru@example.test",
        email_verified: true,
      });

      expect((await onlyUserWithEmail(h.t, "guru@example.test")).id).toBe(userId);
      expect(await allUsersExceptSeed(h.t)).toHaveLength(1);
      expect(await providersOf(h.t, userId)).toEqual(["credential", "google"]);
      await expectSignedIn(h, response, userId);
      // The password keeps working.
      expect((await signIn(h, "guru@example.test", PASSWORD)).status).toBe(200);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "Google sign-in with the email of an UNVERIFIED password user removes the password account and its sessions, then links",
    async () => {
      const h = await harness();
      // The attacker squats the victim's address with a password and never verifies it.
      const userId = await unverifiedPasswordUser(h, VICTIM, ATTACKER_PASSWORD);
      expect(await providersOf(h.t, userId)).toEqual(["credential"]);
      // An unverified user can never start a session (the session guard), so this one is planted
      // directly: whatever sessions the row has, none survives the link.
      const [planted] = await h.t.db
        .insert(sessionTable)
        .values({
          userId,
          token: "planted-attacker-session",
          expiresAt: new Date(Date.now() + 86_400_000),
          updatedAt: new Date(),
        })
        .returning();

      // The victim signs in with Google, which reports the address verified.
      const response = await h.google({
        sub: "sub-victim",
        email: VICTIM,
        email_verified: true,
      });

      // One user, now verified, holding only the Google account.
      const user = await onlyUserWithEmail(h.t, VICTIM);
      expect(user.id).toBe(userId);
      expect(user.emailVerified).toBe(true);
      expect(await providersOf(h.t, userId)).toEqual(["google"]);
      // The planted session is gone; the only session is the victim's new one.
      const sessions = await sessionsOf(h.t, userId);
      expect(sessions.map((s) => s.id)).not.toContain(planted.id);
      expect(sessions).toHaveLength(1);
      await expectSignedIn(h, response, userId);

      // The attacker's password no longer signs in, and a repeated sign-up does not bring it back.
      const attempt = await signIn(h, VICTIM, ATTACKER_PASSWORD);
      expect(attempt.status).toBe(401);
      expect(sessionCookieOf(attempt)).toBeUndefined();
      expect(
        (
          await h.post("/sign-up/email", {
            acceptPrivacy: true,
            name: "Penyusup",
            email: VICTIM,
            password: ATTACKER_PASSWORD,
          })
        ).status,
      ).toBe(200);
      expect(await providersOf(h.t, userId)).toEqual(["google"]);
      expect((await signIn(h, VICTIM, ATTACKER_PASSWORD)).status).toBe(401);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a Google sign-in that lands between the sign-up's user row and its password row leaves no working password",
    async () => {
      let victim: Promise<Response> | undefined;
      const h: Harness = await harness({
        wrapDb: (db) =>
          pauseAfterUserInsert(db, async () => {
            // The victim signs in with Google once the attacker's user row exists but before its
            // password row is written. The victim gets every chance to finish first; where the
            // sign-up runs in a transaction, the victim's requests wait for it instead.
            victim = h.google({ sub: "sub-victim", email: VICTIM, email_verified: true });
            await Promise.race([victim, delay(2000)]);
          }),
      });

      const signUp = await h.post("/sign-up/email", {
        acceptPrivacy: true,
        name: "Penyusup",
        email: VICTIM,
        password: ATTACKER_PASSWORD,
      });
      expect(signUp.status).toBe(200);
      expect(victim).toBeDefined();
      const response = await victim!;

      const user = await onlyUserWithEmail(h.t, VICTIM);
      expect(user.emailVerified).toBe(true);
      await expectSignedIn(h, response, user.id);
      // Whatever the order, the attacker's password does not survive on the verified account.
      expect(await providersOf(h.t, user.id)).toEqual(["google"]);
      expect((await signIn(h, VICTIM, ATTACKER_PASSWORD)).status).toBe(401);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "links nothing when the guard cannot strip the unverified user (error page, all kept)",
    async () => {
      const h = await harness();
      const userId = await unverifiedPasswordUser(h, VICTIM, ATTACKER_PASSWORD);
      // The guard's last write fails, so its transaction rolls back.
      await h.t.client.exec(`
        create function refuse_session_delete() returns trigger language plpgsql as $$
        begin raise exception 'refused'; end $$;
        create trigger refuse_session_delete before delete on "session"
          for each row execute function refuse_session_delete();
      `);
      await h.t.db.insert(sessionTable).values({
        userId,
        token: "planted-attacker-session",
        expiresAt: new Date(Date.now() + 86_400_000),
        updatedAt: new Date(),
      });

      const response = await h.google({
        sub: "sub-victim",
        email: VICTIM,
        email_verified: true,
      });

      expectErrorPage(response);
      const user = await onlyUserWithEmail(h.t, VICTIM);
      expect(user.emailVerified).toBe(false);
      expect(await providersOf(h.t, userId)).toEqual(["credential"]);
      expect(await sessionsOf(h.t, userId)).toHaveLength(1);
    },
    DB_TEST_TIMEOUT,
  );

  describe("Google with email_verified false never links", () => {
    it(
      "creates nothing for a new email and returns the error page",
      async () => {
        const h = await harness();
        const response = await h.google({
          sub: "sub-unverified",
          email: "belum@example.test",
          email_verified: false,
        });
        expectErrorPage(response);
        expect(await allUsersExceptSeed(h.t)).toEqual([]);
        expect(await h.t.db.select().from(accountTable)).toEqual([]);
        expect(await h.t.db.select().from(sessionTable)).toEqual([]);
      },
      DB_TEST_TIMEOUT,
    );

    it(
      "leaves a verified password user untouched and returns the error page",
      async () => {
        const h = await harness();
        const userId = await verifiedPasswordUser(h, "guru@example.test");
        const sessionsBefore = (await sessionsOf(h.t, userId)).map((s) => s.id);

        const response = await h.google({
          sub: "sub-guru",
          email: "guru@example.test",
          email_verified: false,
        });

        expectErrorPage(response);
        expect(await providersOf(h.t, userId)).toEqual(["credential"]);
        expect((await sessionsOf(h.t, userId)).map((s) => s.id)).toEqual(sessionsBefore);
        expect((await signIn(h, "guru@example.test", PASSWORD)).status).toBe(200);
      },
      DB_TEST_TIMEOUT,
    );

    it(
      "leaves an unverified password user untouched (still unverified, password kept) and returns the error page",
      async () => {
        const h = await harness();
        const userId = await unverifiedPasswordUser(h, VICTIM, ATTACKER_PASSWORD);

        const response = await h.google({
          sub: "sub-victim",
          email: VICTIM,
          email_verified: false,
        });

        expectErrorPage(response);
        const user = await onlyUserWithEmail(h.t, VICTIM);
        expect(user.emailVerified).toBe(false);
        expect(await providersOf(h.t, userId)).toEqual(["credential"]);
        expect(await sessionsOf(h.t, userId)).toEqual([]);
      },
      DB_TEST_TIMEOUT,
    );
  });

  it(
    "email case differences still link",
    async () => {
      const h = await harness();
      const userId = await verifiedPasswordUser(h, "guru@example.test");

      const response = await h.google({
        sub: "sub-guru",
        email: "Guru@Example.TEST",
        email_verified: true,
      });

      expect(await allUsersExceptSeed(h.t)).toHaveLength(1);
      expect(await providersOf(h.t, userId)).toEqual(["credential", "google"]);
      await expectSignedIn(h, response, userId);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "email whitespace and case differences still link, and a new Google user is stored normalised",
    async () => {
      const h = await harness();
      const userId = await verifiedPasswordUser(h, "guru@example.test");

      const linked = await h.google({
        sub: "sub-guru",
        email: "  GURU@example.test ",
        email_verified: true,
      });
      expect(await providersOf(h.t, userId)).toEqual(["credential", "google"]);
      await expectSignedIn(h, linked, userId);

      const created = await h.google({
        sub: "sub-new",
        email: " Baru@Example.Test",
        email_verified: true,
      });
      const user = await onlyUserWithEmail(h.t, "baru@example.test");
      await expectSignedIn(h, created, user.id);
      expect(await allUsersExceptSeed(h.t)).toHaveLength(2);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a second Google sign-in is idempotent: same user, still one Google account row",
    async () => {
      const h = await harness();
      const userId = await verifiedPasswordUser(h, "guru@example.test");
      const profile = {
        sub: "sub-guru",
        email: "guru@example.test",
        email_verified: true,
      };

      await expectSignedIn(h, await h.google(profile), userId);
      await expectSignedIn(h, await h.google(profile), userId);

      expect(await allUsersExceptSeed(h.t)).toHaveLength(1);
      expect(await providersOf(h.t, userId)).toEqual(["credential", "google"]);
      expect((await signIn(h, "guru@example.test", PASSWORD)).status).toBe(200);

      // The same for a user Google created.
      const first = await h.google({
        sub: "sub-new",
        email: "baru@example.test",
        email_verified: true,
      });
      const created = await onlyUserWithEmail(h.t, "baru@example.test");
      await expectSignedIn(h, first, created.id);
      await expectSignedIn(
        h,
        await h.google({
          sub: "sub-new",
          email: "baru@example.test",
          email_verified: true,
        }),
        created.id,
      );
      expect(await providersOf(h.t, created.id)).toEqual(["google"]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a Google-only user can add a password only through the reset flow",
    async () => {
      const h = await harness();
      await h.google({ sub: "sub-pak", email: "pak@example.test", email_verified: true });
      const user = await onlyUserWithEmail(h.t, "pak@example.test");

      // A password sign-up for the address adds nothing: the generic answer and the
      // account-exists email.
      const signUp = await h.post("/sign-up/email", {
        acceptPrivacy: true,
        name: "Pak Guru",
        email: "pak@example.test",
        password: PASSWORD,
      });
      expect(signUp.status).toBe(200);
      expect(lastMessage(h.fake).to).toBe("pak@example.test");
      expect(lastMessage(h.fake).subject).toMatch(ACCOUNT_EXISTS_SUBJECT_PATTERN);
      expect(await providersOf(h.t, user.id)).toEqual(["google"]);
      const refused = await signIn(h, "pak@example.test", PASSWORD);
      expect(refused.status).toBe(401);
      expect(await codeOf(refused)).toBe("INVALID_EMAIL_OR_PASSWORD");

      // The reset link sets one.
      h.advance(60);
      await resetPassword(h, "pak@example.test");
      expect(await providersOf(h.t, user.id)).toEqual(["credential", "google"]);
      expect(await allUsersExceptSeed(h.t)).toHaveLength(1);
      expect((await signIn(h, "pak@example.test", NEW_PASSWORD)).status).toBe(200);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("the admin notice trigger for Google accounts (ADR-0022)", () => {
  const ADMIN = "admin@example.test";
  const toAdmin = (fake: FakeEmailSender) =>
    fake.messages.filter((m) => m.subject.startsWith("Akun baru menunggu"));

  it(
    "a new Google user (verified at creation) schedules exactly one notice",
    async () => {
      vi.stubEnv("ADMIN_EMAIL", ADMIN);
      const h = await harness();
      await h.google({ sub: "sub-n", email: "baru@example.test", email_verified: true });
      expect(toAdmin(h.fake)).toHaveLength(1);
      expect(toAdmin(h.fake)[0].text).toContain("baru@example.test");
      // Signing in again later sends nothing more.
      await h.google({ sub: "sub-n", email: "baru@example.test", email_verified: true });
      expect(toAdmin(h.fake)).toHaveLength(1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "the link guard verifying a squatted, unverified account schedules one notice",
    async () => {
      vi.stubEnv("ADMIN_EMAIL", ADMIN);
      const h = await harness();
      const userId = await unverifiedPasswordUser(h, VICTIM, ATTACKER_PASSWORD);
      expect(toAdmin(h.fake)).toEqual([]);
      await h.google({ sub: "sub-victim", email: VICTIM, email_verified: true });
      expect(toAdmin(h.fake)).toHaveLength(1);
      expect(toAdmin(h.fake)[0].text).toContain(VICTIM);
      const [profile] = await h.t.db
        .select()
        .from(profiles)
        .where(eq(profiles.id, userId));
      expect(profile.adminNotifiedAt).toBeInstanceOf(Date);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "linking Google to an already verified password account sends nothing new once it was announced",
    async () => {
      vi.stubEnv("ADMIN_EMAIL", ADMIN);
      const h = await harness();
      await verifiedPasswordUser(h, "guru@example.test");
      expect(toAdmin(h.fake)).toHaveLength(1);
      await h.google({
        sub: "sub-guru",
        email: "guru@example.test",
        email_verified: true,
      });
      expect(toAdmin(h.fake)).toHaveLength(1);
    },
    DB_TEST_TIMEOUT,
  );
});
