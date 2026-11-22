import { Writable } from "node:stream";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  rateLimit as rateLimitTable,
  session as sessionTable,
  user as userTable,
} from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { createLogger, logger, sanitiseError } from "@/lib/logger";
import {
  createAuth,
  createBetterAuthLog,
  createGoogleLinkGuard,
  createSessionCreateGuard,
  createUserCreateGuard,
  DISABLED_AUTH_PATHS,
  EMAIL_NOT_VERIFIED,
  IP_ADDRESS_HEADERS,
  RATE_LIMIT_RULES,
  USED_AUTH_PATHS,
  settleSignInAttempt,
} from "./auth-server";
import { CLIENT_IP_HEADER, requestWithClientIp } from "./client-ip";

const BASE = "http://localhost:3000";
const SECRET = "test-secret-".padEnd(40, "x");
const TEACHER = "guru@example.test";
const STRANGER = "stranger@example.test";

beforeEach(() => {
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});

async function rejectionCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return (error as { body?: { code?: string } }).body?.code;
  }
  return undefined;
}

const usersWithEmail = (t: TestDatabase, email: string) =>
  t.db.select().from(userTable).where(eq(userTable.email, email));

describe("the email-code sign-in is gone", () => {
  it(
    "auth-server has no emailOTP plugin and USED_AUTH_PATHS has no /email-otp path",
    async () => {
      const t = await createTestDatabase();
      const auth = createAuth({
        db: t.db,
        secret: SECRET,
        baseURL: BASE,
        google: null,
        runInBackground: () => undefined,
      });
      const { plugins } = (await auth.$context).options;
      expect(plugins.map((plugin) => plugin.id)).not.toContain("email-otp");
      const paths = Object.values(auth.api)
        .map((endpoint) => (endpoint as { path?: string }).path ?? "")
        .filter((path) => path.includes("otp"));
      expect(paths).toEqual([]);
      expect(USED_AUTH_PATHS.filter((path) => path.includes("otp"))).toEqual([]);
      expect(
        Object.keys(RATE_LIMIT_RULES).filter((path) => path.includes("otp")),
      ).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("createUserCreateGuard (databaseHooks.user.create.before)", () => {
  it("lets any verified email through: there is no allowlist", async () => {
    const guard = createUserCreateGuard();
    for (const email of [TEACHER, STRANGER]) {
      await expect(
        guard({ email, emailVerified: true } as { emailVerified: unknown }, null),
      ).resolves.toBeUndefined();
    }
  });

  it.each([false, undefined, "true"])(
    "rejects an email the provider did not verify (%j)",
    async (emailVerified) => {
      const guard = createUserCreateGuard();
      expect(await rejectionCode(guard({ emailVerified }, null))).toBe(
        EMAIL_NOT_VERIFIED,
      );
      expect(
        await rejectionCode(guard({ emailVerified }, { path: "/callback/:id" })),
      ).toBe(EMAIL_NOT_VERIFIED);
    },
  );

  it("lets an unverified user through only for the email and password sign-up", async () => {
    const guard = createUserCreateGuard();
    await expect(
      guard({ emailVerified: false }, { path: "/sign-up/email" }),
    ).resolves.toBeUndefined();
    for (const path of [
      "/callback/:id",
      "/sign-in/social",
      "/sign-in/email",
      "/sign-up",
    ]) {
      expect(await rejectionCode(guard({ emailVerified: false }, { path })), path).toBe(
        EMAIL_NOT_VERIFIED,
      );
    }
  });
});

describe("createSessionCreateGuard (databaseHooks.session.create.before)", () => {
  it("lets a session for a verified user through", async () => {
    const guard = createSessionCreateGuard(() => Promise.resolve(true));
    await expect(guard({ userId: "u1" })).resolves.toBeUndefined();
  });

  it("rejects a session for an unverified user", async () => {
    const guard = createSessionCreateGuard(() => Promise.resolve(false));
    expect(await rejectionCode(guard({ userId: "u2" }))).toBe(EMAIL_NOT_VERIFIED);
  });

  it("rejects a session for a user that cannot be found", async () => {
    const guard = createSessionCreateGuard(() => Promise.resolve(null));
    expect(await rejectionCode(guard({ userId: "ghost" }))).toBe(EMAIL_NOT_VERIFIED);
  });
});

describe("createGoogleLinkGuard (databaseHooks.account.create.before)", () => {
  function build(emailVerified: boolean | null) {
    const prepare = vi.fn((userId: string) =>
      Promise.resolve(userId).then(() => undefined),
    );
    const guard = createGoogleLinkGuard(() => Promise.resolve(emailVerified), prepare);
    return { guard, prepare };
  }

  it("prepares the link of a Google account to an existing unverified user", async () => {
    const { guard, prepare } = build(false);
    await expect(guard({ providerId: "google", userId: "u1" })).resolves.toBeUndefined();
    expect(prepare).toHaveBeenCalledExactlyOnceWith("u1");
  });

  it("leaves a verified or unknown user alone", async () => {
    for (const emailVerified of [true, null]) {
      const { guard, prepare } = build(emailVerified);
      await guard({ providerId: "google", userId: "u1" });
      expect(prepare, String(emailVerified)).not.toHaveBeenCalled();
    }
  });

  it("leaves every other provider alone (a reset creates the credential account)", async () => {
    const { guard, prepare } = build(false);
    await guard({ providerId: "credential", userId: "u1" });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("fails the account creation when the preparation fails", async () => {
    const guard = createGoogleLinkGuard(
      () => Promise.resolve(false),
      () => Promise.reject(new Error("database down")),
    );
    await expect(guard({ providerId: "google", userId: "u1" })).rejects.toThrow(
      "database down",
    );
  });
});

// The real Better Auth 1.7.25 instance against PGlite with the real migrations: the account hooks
// run on the same write paths the Google callback uses.
describe("Better Auth against PGlite", () => {
  async function build() {
    const t = await createTestDatabase();
    const auth = createAuth({
      db: t.db,
      secret: SECRET,
      baseURL: BASE,
      google: { clientId: "google-client-id", clientSecret: "google-client-secret" },
      runInBackground: () => undefined,
    });
    return { t, auth, context: await auth.$context };
  }
  const googleSource = { method: "oauth", oauth: { providerId: "google" } } as const;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it(
    "creates a uuid user for any verified Google account and lets it start a session",
    async () => {
      const { t, context } = await build();
      const { user } = await context.internalAdapter.createOAuthUser(
        { email: STRANGER, name: "Someone", emailVerified: true },
        { providerId: "google", accountId: "google-sub-1" },
      );
      expect(user.id).toMatch(UUID);
      expect(await usersWithEmail(t, STRANGER)).toHaveLength(1);
      const session = await context.internalAdapter.createSession(user.id);
      expect(session.userId).toBe(user.id);
      expect(await t.db.select().from(sessionTable)).toHaveLength(1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "rejects a Google profile with email_verified false and writes nothing",
    async () => {
      const { t, context } = await build();
      const code = await rejectionCode(
        context.internalAdapter.createUser(
          { email: TEACHER, emailVerified: false, name: "Bu Guru" },
          googleSource,
        ),
      );
      expect(code).toBe(EMAIL_NOT_VERIFIED);
      expect(await usersWithEmail(t, TEACHER)).toEqual([]);
      expect(await t.db.select().from(sessionTable)).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses a new session for an existing user whose email is not verified",
    async () => {
      const { t, context } = await build();
      const [unverified] = await t.db
        .insert(userTable)
        .values({ name: "Unverified", email: TEACHER, emailVerified: false })
        .returning();
      expect(
        await rejectionCode(context.internalAdapter.createSession(unverified.id)),
      ).toBe(EMAIL_NOT_VERIFIED);
      expect(await t.db.select().from(sessionTable)).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("rate limiting per client IP", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads the client address from the one dedicated header only", () => {
    expect(IP_ADDRESS_HEADERS).toEqual([CLIENT_IP_HEADER]);
  });

  async function rateHarness() {
    const t = await createTestDatabase();
    const auth = createAuth({
      db: t.db,
      secret: SECRET,
      baseURL: BASE,
      google: { clientId: "google-client-id", clientSecret: "google-client-secret" },
      runInBackground: () => undefined,
    });
    // Requests go through the same sanitiser the /api/auth route applies. Google sign-in is
    // limited to 3 per 10 s per client IP (RATE_LIMIT_RULES).
    const send = async (headers: Record<string, string>) => {
      const request = await requestWithClientIp(
        new Request(`${BASE}/api/auth/sign-in/social`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE, ...headers },
          body: JSON.stringify({ provider: "google", callbackURL: "/auth/callback" }),
        }),
      );
      return (await auth.handler(request)).status;
    };
    return { auth, send };
  }

  const statuses = async (
    send: (headers: Record<string, string>) => Promise<number>,
    headers: () => Record<string, string>,
  ) => {
    const out: number[] = [];
    for (let i = 0; i < 4; i += 1) out.push(await send(headers()));
    return out;
  };

  it(
    "gives two attested client IPs independent buckets",
    async () => {
      vi.stubEnv("VERCEL", "1");
      const { send } = await rateHarness();
      const a = { "x-vercel-forwarded-for": "192.0.2.61" };
      const b = { "x-vercel-forwarded-for": "192.0.2.62" };
      expect(await statuses(send, () => a)).toEqual([200, 200, 200, 429]);
      expect(await send(b)).toBe(200);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "on Vercel ignores spoofed x-forwarded-for and x-real-ip: one client, one bucket",
    async () => {
      vi.stubEnv("VERCEL", "1");
      const { send } = await rateHarness();
      let i = 0;
      const rotating = () => {
        i += 1;
        return {
          "x-vercel-forwarded-for": "192.0.2.71",
          "x-forwarded-for": `198.51.100.${String(i)}, 203.0.113.${String(i)}`,
          "x-real-ip": `198.51.100.${String(100 + i)}`,
        };
      };
      expect(await statuses(send, rotating)).toEqual([200, 200, 200, 429]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "off Vercel rate limits by the rightmost x-forwarded-for, so a rotating leftmost is one client",
    async () => {
      const { send } = await rateHarness();
      let i = 0;
      const rotating = () => {
        i += 1;
        return { "x-forwarded-for": `6.6.6.${String(i)}, 192.0.2.81` };
      };
      expect(await statuses(send, rotating)).toEqual([200, 200, 200, 429]);
      expect(await send({ "x-forwarded-for": "6.6.6.1, 192.0.2.82" })).toBe(200);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a client supplied copy of the dedicated header cannot choose its bucket",
    async () => {
      vi.stubEnv("VERCEL", "1");
      const { send } = await rateHarness();
      let i = 0;
      const spoofed = () => {
        i += 1;
        return {
          "x-vercel-forwarded-for": "192.0.2.91",
          [CLIENT_IP_HEADER]: `203.0.113.${String(i)}`,
        };
      };
      expect(await statuses(send, spoofed)).toEqual([200, 200, 200, 429]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "requests with no valid address share one restrictive bucket, whatever they send",
    async () => {
      const { send } = await rateHarness();
      let i = 0;
      const garbage = () => {
        i += 1;
        return {
          "x-forwarded-for": `garbage-${String(i)}`,
          [CLIENT_IP_HEADER]: `203.0.113.${String(i)}`,
        };
      };
      expect(await statuses(send, garbage)).toEqual([200, 200, 200, 429]);
      // Another invalid request is in the same bucket; a valid client is not.
      expect(await send({ "x-forwarded-for": "also-garbage" })).toBe(429);
      expect(await send({ "x-forwarded-for": "192.0.2.99" })).toBe(200);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("rate limit rules and storage", () => {
  it("are the decision-7 limits plus an explicit rule for every other used path", () => {
    expect(RATE_LIMIT_RULES).toEqual({
      "/sign-up/email": { window: 60, max: 3 },
      "/sign-in/email": { window: 60, max: 5 },
      "/request-password-reset": { window: 60, max: 3 },
      "/reset-password": { window: 60, max: 5 },
      "/reset-password/*": { window: 60, max: 5 },
      "/send-verification-email": { window: 60, max: 3 },
      "/verify-email": { window: 60, max: 10 },
      "/sign-in/social": { window: 10, max: 3 },
      "/callback/*": { window: 60, max: 10 },
      "/sign-out": { window: 60, max: 10 },
      "/change-password": { window: 60, max: 3 },
      "/verify-password": { window: 60, max: 3 },
    });
  });

  function build(t: TestDatabase) {
    return createAuth({
      db: t.db,
      secret: SECRET,
      baseURL: BASE,
      google: { clientId: "google-client-id", clientSecret: "google-client-secret" },
      runInBackground: () => undefined,
    });
  }
  const post = (path: string, ip: string, body: unknown = {}) =>
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        [CLIENT_IP_HEADER]: ip,
      },
      body: JSON.stringify(body),
    });
  const socialBody = { provider: "google", callbackURL: "/auth/callback" };

  it(
    "keeps the counters in the database, so two server instances share one bucket",
    async () => {
      const t = await createTestDatabase();
      const first = build(t);
      const second = build(t);
      const ip = "192.0.2.101";
      for (let i = 0; i < 3; i += 1) {
        expect(
          (await first.handler(post("/sign-in/social", ip, socialBody))).status,
        ).toBe(200);
      }
      // A second instance (another serverless function) sees the same count.
      expect((await second.handler(post("/sign-in/social", ip, socialBody))).status).toBe(
        429,
      );
      const rows = await t.db.select().from(rateLimitTable);
      expect(rows).toHaveLength(1);
      expect(rows[0].key).toContain("/sign-in/social");
      expect(rows[0].count).toBe(3);
      expect(typeof rows[0].lastRequest).toBe("number");
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "limits the OAuth callback to 10 per 60 s per client IP",
    async () => {
      const t = await createTestDatabase();
      const auth = build(t);
      const callback = (ip: string) =>
        auth.handler(
          new Request(`${BASE}/api/auth/callback/google?code=c&state=s`, {
            headers: { [CLIENT_IP_HEADER]: ip },
          }),
        );
      const statuses: number[] = [];
      for (let i = 0; i < 11; i += 1)
        statuses.push((await callback("192.0.2.102")).status);
      expect(statuses.slice(0, 10).every((status) => status !== 429)).toBe(true);
      expect(statuses[10]).toBe(429);
      expect((await callback("192.0.2.103")).status).not.toBe(429);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "limits sign-out to 10 per 60 s per client IP",
    async () => {
      const t = await createTestDatabase();
      const auth = build(t);
      const statuses: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        statuses.push((await auth.handler(post("/sign-out", "192.0.2.104"))).status);
      }
      expect(statuses.slice(0, 10).every((status) => status !== 429)).toBe(true);
      expect(statuses[10]).toBe(429);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("disabled Better Auth endpoints", () => {
  it("enables exactly what the app uses: Google, email and password, verification, reset and the password change", () => {
    expect([...USED_AUTH_PATHS].sort()).toEqual(
      [
        "/sign-in/social",
        "/callback/:id",
        "/sign-out",
        "/sign-up/email",
        "/sign-in/email",
        "/verify-email",
        "/send-verification-email",
        "/request-password-reset",
        "/reset-password",
        "/reset-password/:token",
        "/change-password",
        "/verify-password",
        "/error",
        "/ok",
      ].sort(),
    );
  });

  async function build() {
    const t = await createTestDatabase();
    return createAuth({
      db: t.db,
      secret: SECRET,
      baseURL: BASE,
      google: { clientId: "google-client-id", clientSecret: "google-client-secret" },
      runInBackground: () => undefined,
    });
  }

  it(
    "answers every disabled path with 404 and every endpoint is classified",
    async () => {
      const auth = await build();
      const exposed = Object.values(auth.api)
        .map((endpoint) => (endpoint as { path?: string }).path)
        .filter((path): path is string => typeof path === "string");
      expect(exposed.length).toBeGreaterThan(20);
      const classified = new Set<string>([...USED_AUTH_PATHS, ...DISABLED_AUTH_PATHS]);
      // A library upgrade that adds an endpoint must be classified here, on purpose.
      expect(exposed.filter((path) => !classified.has(path))).toEqual([]);
      // Nothing is both used and disabled.
      expect(USED_AUTH_PATHS.filter((p) => DISABLED_AUTH_PATHS.includes(p))).toEqual([]);

      // Includes the account, session-list and email-change routes the app does not use.
      for (const path of DISABLED_AUTH_PATHS.filter((p) => !p.includes(":"))) {
        const response = await auth.handler(
          new Request(`${BASE}/api/auth${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: BASE },
            body: "{}",
          }),
        );
        expect(response.status, path).toBe(404);
      }
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "keeps the used POST paths reachable (not 404)",
    async () => {
      const auth = await build();
      for (const path of [
        "/sign-in/social",
        "/sign-out",
        "/sign-up/email",
        "/sign-in/email",
        "/send-verification-email",
        "/request-password-reset",
        "/reset-password",
      ]) {
        const response = await auth.handler(
          new Request(`${BASE}/api/auth${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: BASE,
              [CLIENT_IP_HEADER]: "192.0.2.91",
            },
            body: JSON.stringify({ provider: "google", callbackURL: "/auth/callback" }),
          }),
        );
        expect(response.status, path).not.toBe(404);
      }
    },
    DB_TEST_TIMEOUT,
  );
});

describe("Better Auth log output", () => {
  const SQL = "insert into verification (identifier, value) values ($1, $2)";
  const SECRET_PARAM = "tok_SECRET_session_9f3a";

  function queryError() {
    const driver = Object.assign(
      new Error(`Failed query: ${SQL} params: ${SECRET_PARAM}`),
      {
        query: SQL,
        params: [SECRET_PARAM],
        code: "23505",
      },
    );
    return Object.assign(new Error(`Failed query: ${SQL} params: ${SECRET_PARAM}`), {
      name: "DrizzleQueryError",
      cause: driver,
    });
  }

  function spies() {
    return (["log", "info", "warn", "error", "debug"] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => undefined),
    );
  }

  it("never lets SQL or parameters reach the pino stream or the console", () => {
    const consoleSpies = spies();
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const log = createBetterAuthLog(createLogger(stream));
    log("error", `Failed to create verification ${SQL}`, queryError(), {
      secret: SECRET_PARAM,
    });
    log(
      "warn",
      `retry with ${SECRET_PARAM}`.replace(SECRET_PARAM, "postgres://u:pw1234@h/db"),
    );
    const out = lines.join("");
    expect(out).toContain("better-auth");
    expect(out).toContain("DrizzleQueryError");
    expect(out).not.toContain("verification (identifier");
    expect(out).not.toContain(SECRET_PARAM);
    expect(out).not.toContain("pw1234");
    expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });

  it("drops info and debug output", () => {
    const warn = vi.fn();
    const error = vi.fn();
    const log = createBetterAuthLog({ warn, error });
    log("info", "noise");
    log("debug", "noise");
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it(
    "is the logger the real instance uses: its own error output is sanitised",
    async () => {
      const consoleSpies = spies();
      const t = await createTestDatabase();
      const auth = createAuth({
        db: t.db,
        secret: SECRET,
        baseURL: BASE,
        google: null,
        runInBackground: () => undefined,
      });
      // The real pino serializers, applied to what the logger was given.
      const written: string[] = [];
      for (const level of ["error", "warn"] as const) {
        vi.mocked(logger[level]).mockImplementation(((
          fields: { err?: unknown },
          msg: string,
        ) => {
          written.push(JSON.stringify({ err: sanitiseError(fields.err), msg }));
        }) as never);
      }
      const context = await auth.$context;
      context.logger.error(`boom ${SQL}`, queryError());
      const logged = written.join("");
      expect(written).toHaveLength(1);
      expect(logged).toContain("better-auth");
      expect(logged).not.toContain(SECRET_PARAM);
      expect(logged).not.toContain("Failed query");
      expect(logged).not.toContain("verification (identifier");
      expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("settleSignInAttempt", () => {
  const body = { email: " Guru@Example.TEST ", password: "x" };

  it("gives the attempt back for any answer but a 401, keyed by the normalised address", async () => {
    const settle = vi.fn(() => Promise.resolve());
    await settleSignInAttempt("/sign-in/email", body, { statusCode: 401 }, settle);
    expect(settle).not.toHaveBeenCalled();
    await settleSignInAttempt("/sign-in/email", body, { statusCode: 403 }, settle);
    await settleSignInAttempt("/sign-in/email", body, { token: "t" }, settle);
    expect(settle.mock.calls).toEqual([["guru@example.test"], ["guru@example.test"]]);
    await settleSignInAttempt("/sign-up/email", body, undefined, settle);
    expect(settle).toHaveBeenCalledTimes(2);
  });

  it("never throws when giving the attempt back fails, and logs it without the address", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    await expect(
      settleSignInAttempt("/sign-in/email", body, { token: "t" }, () =>
        Promise.reject(new Error("database down")),
      ),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls)).not.toContain("guru@");
  });
});
