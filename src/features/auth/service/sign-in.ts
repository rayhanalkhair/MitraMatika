import { err, ok } from "@/lib/result";
import { resolveAccess, type Access, type AllowedUser } from "./access";
import type { AuthPort } from "./auth-port";
import { ensureProfile } from "./profile";
import type { AuthResult } from "../schema/types";

async function readAccess(port: AuthPort): Promise<Access> {
  try {
    return resolveAccess(await port.getSessionUser());
  } catch {
    return { status: "anonymous" };
  }
}

async function signOutQuietly(port: AuthPort): Promise<void> {
  try {
    await port.signOut();
  } catch {
    // The caller already reports a failure; a failed sign-out must not mask it.
  }
}

export type SignedInCallback = (user: AllowedUser) => Promise<void> | void;

async function notifySignedIn(callback: SignedInCallback | undefined, user: AllowedUser) {
  if (!callback) return;
  try {
    await callback(user);
  } catch {
    // Best-effort telemetry: a failing audit write must never fail a successful sign-in.
  }
}

/**
 * Runs right after Better Auth has established a session (the Google callback). A signed-in
 * account always ends up with a profile row; any other outcome signs the user out and returns
 * `err(messageKey)`. `onSignedIn` is best effort and never fails sign-in.
 */
export async function completeSignIn(
  port: AuthPort,
  onSignedIn?: SignedInCallback,
): Promise<AuthResult> {
  const access = await readAccess(port);

  if (access.status === "allowed") {
    const profile = await ensureProfile(access);
    if (profile.ok) {
      await notifySignedIn(onSignedIn, access);
      return ok();
    }
    await signOutQuietly(port);
    return profile;
  }

  await signOutQuietly(port);
  return err("generic");
}
