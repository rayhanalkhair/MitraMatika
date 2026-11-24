import { audit, auditExists, AUDIT_SIGN_IN, AUDIT_SIGN_OUT } from "@/lib/events";
import type { AllowedUser, PendingUser } from "./access";
import type { SignedInCallback } from "./sign-in";

// A sign-in is only recorded for a session this young. /auth/callback is a public GET that any
// page can trigger for a signed-in teacher (an <img> is enough), so an older session visiting it
// must not add rows.
export const SIGN_IN_AUDIT_WINDOW_MS = 60_000;

// The audit entry identifies the user by id only: no email address or display name. When the
// session is known the entry is keyed to it, so the same session is audited at most once.
export function auditSignIn(
  method: "google" | "email",
  now: () => number = Date.now,
): SignedInCallback {
  return async (user: AllowedUser | PendingUser) => {
    const created = user.sessionCreatedAt;
    if (created && now() - created.getTime() > SIGN_IN_AUDIT_WINDOW_MS) return;
    const session = user.sessionId
      ? { entityType: "session", entityId: user.sessionId }
      : {};
    if (
      user.sessionId &&
      (await auditExists({ ownerId: user.userId, action: AUDIT_SIGN_IN, ...session }))
    ) {
      return;
    }
    await audit({
      ownerId: user.userId,
      action: AUDIT_SIGN_IN,
      ...session,
      metadata: { method },
    });
  };
}

export async function auditSignOut(user: AllowedUser | PendingUser): Promise<void> {
  await audit({ ownerId: user.userId, action: AUDIT_SIGN_OUT });
}
