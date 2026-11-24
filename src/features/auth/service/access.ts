import { isApprovedEmail } from "./approval";
import type { SessionUser } from "./auth-port";

export interface AllowedUser {
  status: "allowed";
  userId: string;
  email: string;
  displayName: string | null;
  sessionId?: string | null;
  sessionCreatedAt?: Date | null;
}

/** A signed-in, verified account whose email is not approved yet (ADR-0022). */
export interface PendingUser {
  status: "pending";
  userId: string;
  email: string;
  displayName: string | null;
  sessionId?: string | null;
  sessionCreatedAt?: Date | null;
}

export type Access = { status: "anonymous" } | PendingUser | AllowedUser;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Pure, fails closed: anything that is not a session user with an id and an email is anonymous,
 * and so is a failure to decide approval. Sign-up is open and Better Auth's hooks decide who gets
 * a session; `isApproved` (default: the approval rule in approval.ts, read from the
 * environment on every call) then splits signed-in users into allowed and pending.
 */
export function resolveAccess(
  user: SessionUser | null,
  isApproved: (email: string) => boolean = isApprovedEmail,
): Access {
  if (typeof user !== "object" || user === null) return { status: "anonymous" };
  const userId = nonEmptyString(user.id);
  const email = nonEmptyString(user.email)?.toLowerCase();
  if (!userId || !email) return { status: "anonymous" };
  let approved: boolean;
  try {
    approved = isApproved(email);
  } catch {
    return { status: "anonymous" };
  }
  return {
    status: approved ? "allowed" : "pending",
    userId,
    email,
    displayName: nonEmptyString(user.name),
    ...(user.sessionId ? { sessionId: user.sessionId } : {}),
    ...(user.sessionCreatedAt ? { sessionCreatedAt: user.sessionCreatedAt } : {}),
  };
}
