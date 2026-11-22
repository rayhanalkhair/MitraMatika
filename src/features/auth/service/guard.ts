import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { err, ok, type Result } from "@/lib/result";
import type { AllowedUser } from "./access";
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
 * The authoritative sign-in check for pages and layouts: returns the signed-in user or redirects
 * to `/sign-in`.
 * Memoised per request. The proxy only checks that a session cookie exists, so every page,
 * layout, Server Action and data call that needs a user must go through this guard.
 */
export async function requireAllowedUser(): Promise<AllowedUser> {
  const access = await getAccess();
  if (access.status === "allowed") return access;
  redirect("/sign-in");
}

export type ActionAuthorization = Result<
  AllowedUser,
  Extract<AuthErrorKey, "unauthenticated">
>;

/**
 * For Server Actions and route handlers: returns an `ActionAuthorization` instead of redirecting.
 * The only error is `unauthenticated`. Callers map it to their own form state or HTTP status.
 */
export async function authorizeAction(): Promise<ActionAuthorization> {
  const access = await getAccess();
  if (access.status === "allowed") return ok(access);
  return err("unauthenticated");
}
