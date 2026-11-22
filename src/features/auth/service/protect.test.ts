import { NextRequest, NextResponse } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Access } from "./access";
import {
  applyDecision,
  decideProxy,
  hasSessionCookie,
  isPublicPath,
  protect,
} from "./protect";

const request = (path = "/home", cookie?: string, method = "GET") =>
  new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: cookie ? { cookie } : {},
  });

const SESSION = "better-auth.session_token=signed.token";
const SECURE_SESSION = "__Secure-better-auth.session_token=signed.token";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("isPublicPath", () => {
  it.each([
    "/sign-in",
    "/sign-up",
    "/verify-email",
    "/forgot-password",
    "/reset-password",
    "/privacy",
    "/api/health",
    "/api/jobs/run",
    "/auth/callback",
    "/auth",
    "/api/auth/callback/google",
    "/api/auth/sign-in/social",
    "/api/auth/get-session",
  ])("treats %s as public", (path) => {
    expect(isPublicPath(path)).toBe(true);
  });

  it.each([
    "/",
    "/home",
    "/generate",
    "/more",
    "/authority",
    "/sign-in/x",
    "/sign-up/x",
    "/privacy-policy",
    "/reset-password/abc",
    "/api/other",
    "/api/jobs/other",
    "/api/jobs/33333333-3333-4333-8333-333333333333",
    "/api/jobs/run/x",
    "/api/auth",
    "/api/authx/y",
  ])("treats %s as protected", (path) => {
    expect(isPublicPath(path)).toBe(false);
  });
});

describe("decideProxy", () => {
  const anonymous: Access = { status: "anonymous" };
  const allowed: Access = {
    status: "allowed",
    userId: "u",
    email: "teacher@example.test",
    displayName: null,
  };

  it("lets everyone reach public paths", () => {
    for (const access of [anonymous, allowed]) {
      expect(decideProxy("/sign-in", access)).toEqual({ action: "next" });
      expect(decideProxy("/auth/callback", access)).toEqual({ action: "next" });
    }
  });

  it("redirects an anonymous visitor on a protected path to /sign-in", () => {
    expect(decideProxy("/home", anonymous)).toEqual({
      action: "redirect",
      to: "/sign-in",
    });
  });

  it("lets a pending user through: the guards, not the proxy, keep it out", () => {
    expect(
      decideProxy("/home", {
        status: "pending",
        userId: "u",
        email: "new@example.test",
        displayName: null,
      }),
    ).toEqual({ action: "next" });
  });

  it("lets an allowed user through", () => {
    expect(decideProxy("/home", allowed)).toEqual({ action: "next" });
  });
});

describe("applyDecision", () => {
  it("returns the session response untouched for a next decision", () => {
    const session = NextResponse.next();
    expect(applyDecision(request(), session, { action: "next" })).toBe(session);
  });

  it("redirects with 303, carrying the refreshed session cookies and no-store", () => {
    const session = NextResponse.next();
    session.cookies.set("better-auth.session_token", "refreshed", { path: "/" });
    session.headers.set("Pragma", "no-cache");
    session.headers.set("Expires", "0");

    const redirect = applyDecision(request(), session, {
      action: "redirect",
      to: "/sign-in",
    });

    expect(redirect.status).toBe(303);
    expect(redirect.headers.get("location")).toBe("http://localhost:3000/sign-in");
    expect(redirect.cookies.get("better-auth.session_token")?.value).toBe("refreshed");
    expect(redirect.headers.get("Cache-Control")).toBe("private, no-store");
    expect(redirect.headers.get("Pragma")).toBe("no-cache");
    expect(redirect.headers.get("Expires")).toBe("0");
    expect(redirect.headers.get("x-middleware-next")).toBeNull();
  });

  it("keeps the attributes of persistent and deletion session cookies on the redirect", () => {
    const session = NextResponse.next();
    session.cookies.set("better-auth.session_token", "refreshed", {
      path: "/",
      maxAge: 3600,
      sameSite: "lax",
      httpOnly: true,
    });
    session.cookies.set("better-auth.session_token.1", "", { path: "/", maxAge: 0 });

    const redirect = applyDecision(request(), session, {
      action: "redirect",
      to: "/sign-in",
    });

    const setCookies = redirect.headers.getSetCookie();
    expect(setCookies).toHaveLength(2);
    expect(setCookies[0]).toMatch(/max-age=3600/i);
    expect(setCookies[0]).toMatch(/path=\//i);
    expect(setCookies[0]).toMatch(/httponly/i);
    expect(setCookies[0]).toMatch(/samesite=lax/i);
    expect(setCookies[1]).toMatch(/max-age=0/i);
  });

  it("does not leak middleware request-forwarding headers onto the redirect", () => {
    const session = NextResponse.next();
    session.cookies.set("better-auth.session_token", "refreshed", { path: "/" });
    session.headers.set("x-middleware-override-headers", "cookie");
    session.headers.set("x-middleware-request-cookie", "a=b");

    const redirect = applyDecision(request(), session, {
      action: "redirect",
      to: "/sign-in",
    });

    const leaked = [...redirect.headers.keys()].filter(
      (name) => name.startsWith("x-middleware-") && name !== "x-middleware-set-cookie",
    );
    expect(leaked).toEqual([]);
  });
});

describe("hasSessionCookie", () => {
  it("finds the Better Auth session cookie, with or without the secure prefix", () => {
    expect(hasSessionCookie(request("/home", SESSION))).toBe(true);
    expect(hasSessionCookie(request("/home", SECURE_SESSION))).toBe(true);
  });

  it("is false without it", () => {
    expect(hasSessionCookie(request())).toBe(false);
    expect(hasSessionCookie(request("/home", "other=1"))).toBe(false);
  });
});

describe("protect (optimistic cookie check)", () => {
  it("passes a request carrying a session cookie through to the page", async () => {
    const response = await protect(request("/home", SESSION));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("redirects a visitor without a session cookie to /sign-in", async () => {
    const response = await protect(request());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/sign-in");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("sends a visitor to /sign-in when the cookie check throws (fails closed)", async () => {
    const response = await protect(request("/home", SESSION), () => {
      throw new Error("broken");
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/sign-in");
  });

  it("does not need any auth configuration to decide", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    const response = await protect(request("/home", SESSION));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("leaves public paths reachable for anonymous visitors", async () => {
    for (const path of [
      "/sign-in",
      "/api/health",
      "/auth/callback",
      "/api/auth/callback/google",
      "/api/auth/sign-in/social",
    ]) {
      const response = await protect(request(path));
      expect(response.headers.get("x-middleware-next"), path).toBe("1");
    }
  });

  it("redirects a POST to a protected path with 303 so it is not replayed", async () => {
    const response = await protect(request("/home", undefined, "POST"));
    expect(response.status).toBe(303);
  });

  describe("with the e2e fake session enabled", () => {
    const enable = () => {
      vi.stubEnv("E2E_FAKE_AUTH", "1");
      vi.stubEnv("NODE_ENV", "development");
    };

    it("signs in only the fixed test identity from the e2e-user cookie", async () => {
      enable();
      const allowed = await protect(request("/home", "e2e-user=teacher@example.test"));
      expect(allowed.headers.get("x-middleware-next")).toBe("1");

      // Any other value is anonymous: the seam is not a way to become an arbitrary user.
      for (const value of ["stranger@example.test", "TEACHER@example.test"]) {
        const other = await protect(request("/home", `e2e-user=${value}`));
        expect(other.status, value).toBe(303);
        expect(other.headers.get("location"), value).toBe(
          "http://localhost:3000/sign-in",
        );
      }
    });

    it("ignores the cookie when the e2e flag is unset", async () => {
      vi.stubEnv("E2E_FAKE_AUTH", "");
      vi.stubEnv("NODE_ENV", "development");
      const response = await protect(request("/home", "e2e-user=teacher@example.test"));
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("http://localhost:3000/sign-in");
    });

    it("treats a missing e2e cookie as anonymous even with a real session cookie", async () => {
      enable();
      const response = await protect(request("/home", SESSION));
      expect(response.headers.get("location")).toBe("http://localhost:3000/sign-in");
    });

    it("ignores the cookie entirely in production", async () => {
      enable();
      vi.stubEnv("NODE_ENV", "production");
      const response = await protect(request("/home", "e2e-user=teacher@example.test"));
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("http://localhost:3000/sign-in");
    });
  });
});
