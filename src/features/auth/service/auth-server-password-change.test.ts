import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  account as accountTable,
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
import { createAuthPort, type CookieOptions } from "./auth-port";
import { createAuth, RATE_LIMIT_RULES, type Auth } from "./auth-server";
import { CLIENT_IP_HEADER } from "./client-ip";

// Settings > Akun: changing the password (decision 9) on the real Better Auth 1.7.25 instance
// against PGlite with the real migrations, through auth.handler (the auth port's path), so the
// per-IP limit and the password policy hook apply exactly as in production.
const BASE = "http://localhost:3000";
const SECRET = "test-secret-".padEnd(40, "x");
const PASSWORD = "rahasia123";
const NEW_PASSWORD = "baruSekali42";

beforeEach(() => {
  vi.stubEnv("VERCEL", "");
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

interface Harness {
  t: TestDatabase;
  auth: Auth;
  fake: FakeEmailSender;
  post: (
    path: string,
    body: unknown,
    options?: { cookie?: string; ip?: string },
  ) => Promise<Response>;
  get: (url: string) => Promise<Response>;
}

async function harness(): Promise<Harness> {
  const t = await createTestDatabase();
  const fake = createFakeEmailSender();
  const pending: Promise<unknown>[] = [];
  const flush = async () => {
    while (pending.length > 0) await Promise.all(pending.splice(0));
  };
  let nextIp = 1;
  const freshIp = () => `198.51.100.${String(nextIp++)}`;
  const auth = createAuth({
    db: t.db,
    secret: SECRET,
    baseURL: BASE,
    google: null,
    getSender: () => fake.send,
    runInBackground: (task) => {
      pending.push(task);
    },
    responseFloorsMs: {},
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
    post: (path, body, options = {}) =>
      send(
        new Request(`${BASE}/api/auth${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: BASE,
            [CLIENT_IP_HEADER]: options.ip ?? freshIp(),
            ...(options.cookie ? { cookie: options.cookie } : {}),
          },
          body: JSON.stringify(body),
        }),
      ),
    get: (url) => send(new Request(url, { headers: { [CLIENT_IP_HEADER]: freshIp() } })),
  };
}

const sessionCookieOf = (response: Response) =>
  /better-auth\.session_token=[^;]+/.exec(response.headers.get("set-cookie") ?? "")?.[0];

async function codeOf(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { code?: string }).code;
}

/** A verified password user and the cookie of a fresh sign-in. */
async function verifiedPasswordUser(h: Harness, email: string): Promise<string> {
  await h.post("/sign-up/email", {
    acceptPrivacy: true,
    name: "Bu Guru",
    email,
    password: PASSWORD,
  });
  const message = h.fake.messages[h.fake.messages.length - 1];
  const link = /https?:\/\/\S+\/verify-email\?\S+/.exec(message.text)?.[0];
  expect(link).toBeDefined();
  await h.get(link ?? "");
  const [row] = await h.t.db.select().from(userTable).where(eq(userTable.email, email));
  return row.id;
}

async function signIn(h: Harness, email: string, password: string): Promise<string> {
  const response = await h.post("/sign-in/email", { email, password });
  expect(response.status).toBe(200);
  const cookie = sessionCookieOf(response);
  expect(cookie).toBeDefined();
  return cookie ?? "";
}

const sessionOf = (h: Harness, cookie: string) =>
  h.auth.api.getSession({ headers: new Headers({ cookie }) });

const change = (h: Harness, cookie: string | undefined, body: Record<string, unknown>) =>
  h.post("/change-password", { revokeOtherSessions: true, ...body }, { cookie });

describe("change password (real Better Auth, PGlite)", () => {
  it(
    "change password needs the current password, applies the policy and revokes other sessions",
    async () => {
      const h = await harness();
      const userId = await verifiedPasswordUser(h, "guru@example.test");
      const here = await signIn(h, "guru@example.test", PASSWORD);
      const elsewhere = await signIn(h, "guru@example.test", PASSWORD);

      // A wrong current password: refused, and it says only that.
      const wrong = await change(h, here, {
        currentPassword: "salah12345",
        newPassword: NEW_PASSWORD,
      });
      expect(wrong.status).toBe(400);
      expect(await codeOf(wrong)).toBe("INVALID_PASSWORD");

      // The policy: letters and digits (Better Auth itself checks only the length).
      const weak = await change(h, here, {
        currentPassword: PASSWORD,
        newPassword: "hanyahuruf",
      });
      expect(weak.status).toBe(400);
      expect(await codeOf(weak)).toBe("PASSWORD_NEEDS_LETTER_AND_DIGIT");
      const short = await change(h, here, {
        currentPassword: PASSWORD,
        newPassword: "a1",
      });
      expect(await codeOf(short)).toBe("PASSWORD_TOO_SHORT");

      // Nothing changed so far: both sessions live, the old password still signs in.
      expect(await sessionOf(h, here)).not.toBeNull();
      expect(await sessionOf(h, elsewhere)).not.toBeNull();

      const changed = await change(h, here, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      expect(changed.status).toBe(200);
      const fresh = sessionCookieOf(changed);
      expect(fresh).toBeDefined();

      // This device stays signed in (with a new session); every other session is gone.
      expect((await sessionOf(h, fresh ?? ""))?.user.id).toBe(userId);
      expect(await sessionOf(h, elsewhere)).toBeNull();
      expect(await sessionOf(h, here)).toBeNull();
      const sessions = await h.t.db
        .select()
        .from(sessionTable)
        .where(eq(sessionTable.userId, userId));
      expect(sessions).toHaveLength(1);

      expect(
        (
          await h.post("/sign-in/email", {
            email: "guru@example.test",
            password: PASSWORD,
          })
        ).status,
      ).toBe(401);
      await signIn(h, "guru@example.test", NEW_PASSWORD);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "revokes the other sessions even when a client asks not to",
    async () => {
      const h = await harness();
      await verifiedPasswordUser(h, "guru@example.test");
      const here = await signIn(h, "guru@example.test", PASSWORD);
      const elsewhere = await signIn(h, "guru@example.test", PASSWORD);
      const changed = await change(h, here, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
        revokeOtherSessions: false,
      });
      expect(changed.status).toBe(200);
      expect(await sessionOf(h, elsewhere)).toBeNull();
      expect(await sessionOf(h, sessionCookieOf(changed) ?? "")).not.toBeNull();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses without a session and for a user without a password, changing nothing",
    async () => {
      const h = await harness();
      await verifiedPasswordUser(h, "guru@example.test");
      const anonymous = await change(h, undefined, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      expect(anonymous.status).toBe(401);

      // A user without a password (a Google-only user has no credential account) cannot set one
      // here: that is the reset flow's job.
      const otherId = await verifiedPasswordUser(h, "google@example.test");
      const cookie = await signIn(h, "google@example.test", PASSWORD);
      await h.t.db
        .delete(accountTable)
        .where(
          and(
            eq(accountTable.userId, otherId),
            eq(accountTable.providerId, "credential"),
          ),
        );
      const response = await change(h, cookie, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      expect(response.status).toBe(400);
      expect(await codeOf(response)).toBe("CREDENTIAL_ACCOUNT_NOT_FOUND");
      expect(
        await h.t.db.select().from(accountTable).where(eq(accountTable.userId, otherId)),
      ).toEqual([]);

      expect(
        (
          await h.post("/sign-in/email", {
            email: "guru@example.test",
            password: PASSWORD,
          })
        ).status,
      ).toBe(200);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "limits /change-password to 3 per 60 s per client IP",
    async () => {
      const h = await harness();
      await verifiedPasswordUser(h, "guru@example.test");
      const cookie = await signIn(h, "guru@example.test", PASSWORD);
      expect(RATE_LIMIT_RULES["/change-password"]).toEqual({ window: 60, max: 3 });
      const ip = "203.0.113.50";
      const body = { currentPassword: "salah12345", newPassword: NEW_PASSWORD };
      for (let i = 0; i < 3; i += 1) {
        expect((await h.post("/change-password", body, { cookie, ip })).status).not.toBe(
          429,
        );
      }
      expect((await h.post("/change-password", body, { cookie, ip })).status).toBe(429);
      expect(
        (await h.post("/change-password", body, { cookie, ip: "203.0.113.51" })).status,
      ).not.toBe(429);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "through the auth port: wrong_password, then the change sets the new session cookie",
    async () => {
      const h = await harness();
      await verifiedPasswordUser(h, "guru@example.test");
      const cookie = await signIn(h, "guru@example.test", PASSWORD);
      const set: { name: string; value: string; options: CookieOptions }[] = [];
      let ip = 10;
      const port = createAuthPort(h.auth, {
        baseURL: BASE,
        requestHeaders: () =>
          Promise.resolve(
            new Headers({ cookie, "x-forwarded-for": `192.0.2.${String(ip++)}` }),
          ),
        setCookie: (name, value, options) => {
          set.push({ name, value, options });
        },
      });

      expect(
        await port.changePassword({
          currentPassword: "salah12345",
          newPassword: NEW_PASSWORD,
        }),
      ).toEqual({ error: { code: "wrong_password" } });
      expect(
        await port.changePassword({
          currentPassword: PASSWORD,
          newPassword: "hanyahuruf",
        }),
      ).toEqual({ error: { code: "invalid_input" } });
      expect(set).toEqual([]);

      expect(
        await port.changePassword({
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
        }),
      ).toEqual({ error: null });
      const token = set.find((c) => c.name === "better-auth.session_token");
      expect(token?.value).toBeTruthy();
      expect(
        await sessionOf(h, `better-auth.session_token=${token?.value ?? ""}`),
      ).not.toBeNull();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "limits password checks per user at the route: the 6th from different IPs is refused, even with the right password",
    async () => {
      const h = await harness();
      const userId = await verifiedPasswordUser(h, "guru@example.test");
      const cookie = await signIn(h, "guru@example.test", PASSWORD);
      const wrong = { currentPassword: "salah12345", newPassword: NEW_PASSWORD };
      // Change and verify share one budget of 5 per user, whatever the address.
      for (let i = 0; i < 3; i += 1) {
        const response = await h.post("/change-password", wrong, {
          cookie,
          ip: `203.0.113.${String(60 + i)}`,
        });
        expect(await codeOf(response)).toBe("INVALID_PASSWORD");
      }
      for (let i = 0; i < 2; i += 1) {
        const response = await h.post(
          "/verify-password",
          { password: "salah12345" },
          { cookie, ip: `203.0.113.${String(70 + i)}` },
        );
        expect(await codeOf(response)).toBe("INVALID_PASSWORD");
      }
      const sixth = await h.post(
        "/change-password",
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        { cookie, ip: "203.0.113.80" },
      );
      expect(sixth.status).toBe(429);
      expect(await codeOf(sixth)).toBe("TOO_MANY_ATTEMPTS");
      const verify = await h.post(
        "/verify-password",
        { password: PASSWORD },
        { cookie, ip: "203.0.113.81" },
      );
      expect(verify.status).toBe(429);
      // Nothing changed: the old password still signs in, the session still works.
      expect((await sessionOf(h, cookie))?.user.id).toBe(userId);
      await signIn(h, "guru@example.test", PASSWORD);

      // Another user has a budget of their own.
      await verifiedPasswordUser(h, "lain@example.test");
      const other = await signIn(h, "lain@example.test", PASSWORD);
      expect(
        (await h.post("/verify-password", { password: PASSWORD }, { cookie: other }))
          .status,
      ).toBe(200);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "verify-password needs a session, answers 200 for the right password and is limited to 3 per 60 s per IP",
    async () => {
      const h = await harness();
      await verifiedPasswordUser(h, "guru@example.test");
      const cookie = await signIn(h, "guru@example.test", PASSWORD);
      expect(RATE_LIMIT_RULES["/verify-password"]).toEqual({ window: 60, max: 3 });
      expect((await h.post("/verify-password", { password: PASSWORD })).status).toBe(401);
      expect(
        (await h.post("/verify-password", { password: PASSWORD }, { cookie })).status,
      ).toBe(200);
      const ip = "203.0.113.90";
      for (let i = 0; i < 3; i += 1) {
        await h.post("/verify-password", { password: "salah12345" }, { cookie, ip });
      }
      expect(
        (await h.post("/verify-password", { password: PASSWORD }, { cookie, ip })).status,
      ).toBe(429);
    },
    DB_TEST_TIMEOUT,
  );
});
