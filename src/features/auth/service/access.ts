import type { SessionUser } from "./auth-port";

export interface AllowedUser {
  status: "allowed";
  userId: string;
  email: string;
  displayName: string | null;
  sessionId?: string | null;
  sessionCreatedAt?: Date | null;
}

export type Access = { status: "anonymous" } | AllowedUser;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Pure, fails closed: anything that is not a session user with an id and an email is anonymous.
 * Sign-up is open, so every such user is allowed; Better Auth's hooks decide who gets a session.
 */
export function resolveAccess(user: SessionUser | null): Access {
  if (typeof user !== "object" || user === null) return { status: "anonymous" };
  const userId = nonEmptyString(user.id);
  const email = nonEmptyString(user.email)?.toLowerCase();
  if (!userId || !email) return { status: "anonymous" };
  return {
    status: "allowed",
    userId,
    email,
    displayName: nonEmptyString(user.name),
    ...(user.sessionId ? { sessionId: user.sessionId } : {}),
    ...(user.sessionCreatedAt ? { sessionCreatedAt: user.sessionCreatedAt } : {}),
  };
}
