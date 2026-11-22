import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/lib/logger";
import { CLIENT_IP_HEADER } from "./client-ip";
import {
  createAuthPort,
  withCurrentCookies,
  type AuthHandle,
  type PortIO,
} from "./auth-port";

const BASE = "https://app.example.test";

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function setup(
  respond: (request: Request) => Response | Promise<Response>,
  overrides: Partial<PortIO> = {},
) {
  const requests: Request[] = [];
  const cookies: { name: string; value: string; options: unknown }[] = [];
  const getSession = vi.fn<AuthHandle["api"]["getSession"]>(() => Promise.resolve(null));
  const auth: AuthHandle = {
    handler: async (request) => {
      requests.push(request);
      return respond(request);
    },
    api: { getSession },
  };
  const io: PortIO = {
    baseURL: BASE,
    requestHeaders: () =>
      Promise.resolve(
        new Headers({
          "x-forwarded-for": "203.0.113.7",
          "user-agent": "Browser/1.0",
          cookie: "better-auth.session_token=abc",
        }),
      ),
    setCookie: (name, value, options) => {
      cookies.push({ name, value, options });
    },
    ...overrides,
  };
  return { port: createAuthPort(auth, io), requests, cookies, getSession };
}

beforeEach(() => {
  vi.stubEnv("VERCEL", "");
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("forwarded client IP", () => {
  const withHeaders = (entries: Record<string, string>) =>
    setup(() => json(200, { success: true }), {
      requestHeaders: () => Promise.resolve(new Headers(entries)),
    });
  const sent = (request: Request) => ({
    ip: request.headers.get(CLIENT_IP_HEADER),
    raw: ["x-forwarded-for", "x-real-ip", "x-vercel-forwarded-for"].filter((name) =>
      request.headers.has(name),
    ),
  });

  it("passes the resolved address in the one dedicated header and nothing else", async () => {
    vi.stubEnv("VERCEL", "");
    const { port, requests } = withHeaders({
      "x-forwarded-for": "6.6.6.6, 203.0.113.3",
      "x-real-ip": "garbage",
    });
    await port.signOut();
    expect(sent(requests[0])).toEqual({ ip: "203.0.113.3", raw: [] });
  });

  it("on Vercel passes only the attested address", async () => {
    vi.stubEnv("VERCEL", "1");
    const { port, requests } = withHeaders({
      "x-vercel-forwarded-for": "203.0.113.1",
      "x-forwarded-for": "6.6.6.6",
      "x-real-ip": "7.7.7.7",
    });
    await port.signOut();
    expect(sent(requests[0])).toEqual({ ip: "203.0.113.1", raw: [] });
  });

  it("sends no address, and ignores a client copy of the dedicated header, when none is valid", async () => {
    vi.stubEnv("VERCEL", "");
    const { port, requests } = withHeaders({
      "x-forwarded-for": "garbage",
      [CLIENT_IP_HEADER]: "6.6.6.6",
    });
    await port.signOut();
    expect(sent(requests[0])).toEqual({ ip: null, raw: [] });
  });
});

describe("signOut", () => {
  it("posts the session cookie to sign-out and applies the cookie deletions", async () => {
    const { port, requests, cookies } = setup(() =>
      json(
        200,
        { success: true },
        {
          "set-cookie": "better-auth.session_token=; Path=/; Max-Age=0",
        },
      ),
    );
    await expect(port.signOut()).resolves.toEqual({ error: null });
    expect(requests[0].url).toBe(`${BASE}/api/auth/sign-out`);
    expect(requests[0].headers.get("cookie")).toBe("better-auth.session_token=abc");
    expect(cookies).toEqual([
      {
        name: "better-auth.session_token",
        value: "",
        options: expect.objectContaining({ maxAge: 0 }) as unknown,
      },
    ]);
  });

  it.each([
    [403, "TOO_MANY_ATTEMPTS", "rate_limited"],
    [429, undefined, "rate_limited"],
    [500, "INTERNAL", "unavailable"],
    [400, "SOMETHING_ELSE", "unavailable"],
  ])("maps %i %s to %s and applies no cookie", async (status, code, expected) => {
    const { port, cookies } = setup(() => json(status, code ? { code } : {}));
    await expect(port.signOut()).resolves.toEqual({ error: { code: expected } });
    expect(cookies).toEqual([]);
  });

  it("maps a non-JSON error body to unavailable", async () => {
    const { port } = setup(() => new Response("oops", { status: 502 }));
    await expect(port.signOut()).resolves.toEqual({ error: { code: "unavailable" } });
  });
});

describe("getSessionUser", () => {
  it("returns null without a session", async () => {
    const { port } = setup(() => json(200, {}));
    await expect(port.getSessionUser()).resolves.toBeNull();
  });

  it("returns the id, email and name of the session user", async () => {
    const { port, getSession } = setup(() => json(200, {}));
    getSession.mockResolvedValue({
      user: { id: "u1", email: "guru@example.test", name: "Bu Guru" },
    });
    await expect(port.getSessionUser()).resolves.toEqual({
      id: "u1",
      email: "guru@example.test",
      name: "Bu Guru",
    });
    expect(getSession.mock.calls[0]?.[0].headers).toBeInstanceOf(Headers);
  });

  it("also returns the session id and creation time when Better Auth gives them", async () => {
    const { port, getSession } = setup(() => json(200, {}));
    const createdAt = new Date("2026-11-16T01:00:00.000Z");
    getSession.mockResolvedValue({
      user: { id: "u1", email: "guru@example.test" },
      session: { id: "s1", createdAt },
    });
    await expect(port.getSessionUser()).resolves.toMatchObject({
      id: "u1",
      sessionId: "s1",
      sessionCreatedAt: createdAt,
    });
  });

  it("reads an ISO string creation time and ignores an unparsable one", async () => {
    const { port, getSession } = setup(() => json(200, {}));
    getSession.mockResolvedValue({
      user: { id: "u1", email: "a@b.co" },
      session: { id: "s1", createdAt: "2026-11-16T01:00:00.000Z" },
    });
    expect((await port.getSessionUser())?.sessionCreatedAt?.toISOString()).toBe(
      "2026-11-16T01:00:00.000Z",
    );
    getSession.mockResolvedValue({
      user: { id: "u1", email: "a@b.co" },
      session: { id: "s1", createdAt: "garbage" },
    });
    expect(await port.getSessionUser()).not.toHaveProperty("sessionCreatedAt");
  });
});

describe("withCurrentCookies", () => {
  it("replaces the Cookie header with the current cookie store, encoded", () => {
    const merged = withCurrentCookies(
      new Headers({ cookie: "old=1", "x-forwarded-for": "203.0.113.7" }),
      [
        { name: "better-auth.session_token", value: "tok.sig+/=" },
        { name: "deleted", value: "" },
      ],
    );
    expect(merged.get("cookie")).toBe("better-auth.session_token=tok.sig%2B%2F%3D");
    expect(merged.get("x-forwarded-for")).toBe("203.0.113.7");
  });

  it("drops the Cookie header when the store is empty", () => {
    expect(withCurrentCookies(new Headers({ cookie: "old=1" }), []).has("cookie")).toBe(
      false,
    );
  });
});

describe("email and password calls (through auth.handler)", () => {
  const bodyOf = async (request: Request) => (await request.json()) as unknown;

  it("signs in with email and password and applies the session cookie", async () => {
    const { port, requests, cookies } = setup(() =>
      json(
        200,
        { token: "t" },
        { "set-cookie": "better-auth.session_token=new.signed; Path=/; HttpOnly" },
      ),
    );
    await expect(
      port.signInEmail({
        email: "guru@example.test",
        password: "rahasia123",
        callbackURL: "/auth/callback?method=email",
      }),
    ).resolves.toEqual({ error: null });
    expect(requests[0].url).toBe(`${BASE}/api/auth/sign-in/email`);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].headers.get("origin")).toBe(BASE);
    // A sign-in never carries the old session along.
    expect(requests[0].headers.get("cookie")).toBeNull();
    expect(await bodyOf(requests[0])).toEqual({
      email: "guru@example.test",
      password: "rahasia123",
      callbackURL: "/auth/callback?method=email",
    });
    expect(cookies.map((cookie) => cookie.name)).toEqual(["better-auth.session_token"]);
  });

  it("posts a sign-up with only the fields Better Auth needs, and the privacy consent", async () => {
    const { port, requests } = setup(() => json(200, { token: null, user: {} }));
    await port.signUpEmail({
      name: "Bu Rina",
      email: "rina@example.test",
      password: "rahasia123",
      schoolName: "SMP 1",
      callbackURL: "/auth/callback?method=email",
    });
    expect(requests[0].url).toBe(`${BASE}/api/auth/sign-up/email`);
    expect(await bodyOf(requests[0])).toEqual({
      name: "Bu Rina",
      email: "rina@example.test",
      password: "rahasia123",
      schoolName: "SMP 1",
      callbackURL: "/auth/callback?method=email",
      acceptPrivacy: true,
    });
  });

  it("asks for a new verification link", async () => {
    const { port, requests } = setup(() => json(200, { status: true }));
    await expect(
      port.sendVerificationEmail({
        email: "rina@example.test",
        callbackURL: "/auth/callback?method=email",
      }),
    ).resolves.toEqual({ error: null });
    expect(requests[0].url).toBe(`${BASE}/api/auth/send-verification-email`);
    expect(requests[0].headers.get("cookie")).toBeNull();
    expect(await bodyOf(requests[0])).toEqual({
      email: "rina@example.test",
      callbackURL: "/auth/callback?method=email",
    });
  });

  it("requests a password reset with the address only: no redirectTo of any kind", async () => {
    const { port, requests } = setup(() => json(200, { status: true }));
    await expect(
      port.requestPasswordReset({ email: "rina@example.test" }),
    ).resolves.toEqual({ error: null });
    expect(requests[0].url).toBe(`${BASE}/api/auth/request-password-reset`);
    expect(await bodyOf(requests[0])).toEqual({ email: "rina@example.test" });
  });

  it("resets the password with the token and the new password", async () => {
    const { port, requests } = setup(() => json(200, { status: true }));
    await port.resetPassword({ token: "tok", newPassword: "baru12345" });
    expect(requests[0].url).toBe(`${BASE}/api/auth/reset-password`);
    expect(await bodyOf(requests[0])).toEqual({ token: "tok", newPassword: "baru12345" });
  });

  it.each([
    [401, "INVALID_EMAIL_OR_PASSWORD", "invalid_credentials"],
    [403, "EMAIL_NOT_VERIFIED", "email_not_verified"],
    [400, "INVALID_TOKEN", "invalid_token"],
    [400, "TOKEN_EXPIRED", "invalid_token"],
    [400, "USER_NOT_FOUND", "invalid_token"],
    [400, "PASSWORD_TOO_SHORT", "invalid_input"],
    [400, "PASSWORD_NEEDS_LETTER_AND_DIGIT", "invalid_input"],
    [400, "INVALID_SIGN_UP", "invalid_input"],
    [400, "INVALID_EMAIL", "invalid_input"],
    [400, "VALIDATION_ERROR", "invalid_input"],
    [429, undefined, "rate_limited"],
    [500, "INTERNAL", "unavailable"],
  ])("maps %i %s to %s", async (status, code, expected) => {
    const { port, cookies } = setup(() => json(status, code ? { code } : {}));
    await expect(
      port.signInEmail({ email: "a@b.test", password: "x", callbackURL: "/" }),
    ).resolves.toEqual({ error: { code: expected } });
    expect(cookies).toEqual([]);
  });
});
