import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { resolveAccess, type Access } from "./access";
import { E2E_COOKIE, fakeSessionUser, isFakeAuthEnabled } from "./e2e-session";

export type ProxyDecision = { action: "next" } | { action: "redirect"; to: string };

// The auth screens and the privacy notice, reachable without a session (exact paths only).
const PUBLIC_PAGES = new Set([
  "/sign-in",
  "/sign-up",
  "/verify-email",
  "/forgot-password",
  "/reset-password",
  "/privacy",
]);

export function isPublicPath(pathname: string): boolean {
  return (
    PUBLIC_PAGES.has(pathname) ||
    pathname === "/api/health" ||
    pathname === "/api/jobs/run" ||
    pathname.startsWith("/api/auth/") ||
    pathname === "/auth" ||
    pathname.startsWith("/auth/")
  );
}

export function decideProxy(pathname: string, access: Access): ProxyDecision {
  if (isPublicPath(pathname) || access.status === "allowed") return { action: "next" };
  return { action: "redirect", to: "/sign-in" };
}

const SESSION_HEADERS_TO_KEEP = ["expires", "pragma"];

// 303 turns any method (including a server-action POST) into a GET on the target.
export function applyDecision(
  request: NextRequest,
  session: NextResponse,
  decision: ProxyDecision,
): NextResponse {
  if (decision.action === "next") return session;

  const redirect = NextResponse.redirect(new URL(decision.to, request.url), 303);
  session.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
  SESSION_HEADERS_TO_KEEP.forEach((name) => {
    const value = session.headers.get(name);
    if (value) redirect.headers.set(name, value);
  });
  redirect.headers.set("Cache-Control", "private, no-store");
  return redirect;
}

/**
 * Optimistic: only whether Better Auth's session cookie is present. No database call and no
 * configuration. The guard (guard.ts) validates the session.
 */
export function hasSessionCookie(request: NextRequest): boolean {
  return getSessionCookie(request) !== null;
}

function cookieSaysSignedIn(
  request: NextRequest,
  hasSession: (request: NextRequest) => boolean,
): boolean {
  try {
    return hasSession(request);
  } catch {
    return false;
  }
}

export function protect(
  request: NextRequest,
  hasSession: (request: NextRequest) => boolean = hasSessionCookie,
): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  let decision: ProxyDecision;
  if (isFakeAuthEnabled()) {
    const user = fakeSessionUser(request.cookies.get(E2E_COOKIE)?.value);
    decision = decideProxy(pathname, resolveAccess(user));
  } else if (isPublicPath(pathname) || cookieSaysSignedIn(request, hasSession)) {
    decision = { action: "next" };
  } else {
    decision = { action: "redirect", to: "/sign-in" };
  }
  return Promise.resolve(applyDecision(request, NextResponse.next(), decision));
}
