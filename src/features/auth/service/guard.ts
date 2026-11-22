import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { err, ok, type Result } from "@/lib/result";
import type { AllowedUser, PendingUser } from "./access";
import { E2E_COOKIE } from "./e2e-session";
import { loadAccess } from "./load-access";
import { getAuthPort } from "./port-server";
import type { AuthErrorKey } from "../schema/types";

// Memoised per request. Every page, layout, server action and data call that needs a user
// must go through this guard: the proxy only checks that a session cookie exists, it does not
// cover server-action POSTs, and layouts do not re-render on client-side navigation. This is the
// authoritative check: Better Auth validates the session.
const getAccess = cache(() =>
  loadAccess({
    getPort: getAuthPort,
    readE2eCookie: async () => (await cookies()).get(E2E_COOKIE)?.value,
  }),
);

/**
 * The authoritative check for pages and layouts: returns the signed-in, approved user, sends an
 * anonymous visitor to `/sign-in` and a pending account (signed in, email not approved) to
 * `/waiting-approval` (ADR-0022).
 * Memoised per request. The proxy only checks that a session cookie exists, so every page,
 * layout, Server Action and data call that needs a user must go through this guard.
 */
export async function requireAllowedUser(): Promise<AllowedUser> {
  const access = await getAccess();
  if (access.status === "allowed") return access;
  if (access.status === "pending") redirect("/waiting-approval");
  redirect("/sign-in");
}

/**
 * Like `requireAllowedUser`, but a pending account gets through too. Only for what a pending
 * account may do (the waiting page, sign-out, account deletion); the route-guard inventory test
 * allows it only for entries on its PENDING_ALLOWED list.
 */
export async function requireSignedInUser(): Promise<AllowedUser | PendingUser> {
  const access = await getAccess();
  if (access.status === "anonymous") redirect("/sign-in");
  return access;
}

export type ActionAuthorization = Result<
  AllowedUser,
  Extract<AuthErrorKey, "unauthenticated">
>;

/**
 * For Server Actions and route handlers: returns an `ActionAuthorization` instead of redirecting.
 * The only error is `unauthenticated`, also for a pending account (a crafted request by one gets
 * 401; the UI redirects it first). Callers map it to their own form state or HTTP status.
 */
export async function authorizeAction(): Promise<ActionAuthorization> {
  const access = await getAccess();
  if (access.status === "allowed") return ok(access);
  return err("unauthenticated");
}

/** The signed-in counterpart of `authorizeAction`: a pending account is accepted too. */
export async function authorizeSignedIn(): Promise<
  Result<AllowedUser | PendingUser, Extract<AuthErrorKey, "unauthenticated">>
> {
  const access = await getAccess();
  if (access.status === "anonymous") return err("unauthenticated");
  return ok(access);
}
