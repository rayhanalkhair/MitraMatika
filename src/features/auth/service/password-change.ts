import { createHmac } from "node:crypto";
import { and, count, eq, gt, lte } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import { verification } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { err, ok, type Result } from "@/lib/result";
import type { AuthPort, AuthPortError } from "./auth-port";

// Every check of the signed-in user's current password (Better Auth's /change-password and
// /verify-password, the latter before an account deletion) counts against the account: at most 5
// in 15 minutes. Better Auth's per-IP limit (3 per 60 s) alone does not stop someone guessing
// from many addresses with a stolen session cookie. The count is enforced in Better Auth's request
// hook (auth-server.ts), so the Settings actions and a direct call to /api/auth share it.
export const PASSWORD_CHANGE_ATTEMPTS = 5;
export const PASSWORD_CHANGE_WINDOW_SECONDS = 15 * 60;

const LABEL = "password-attempt";

export interface AttemptLimiter {
  /** True when one more attempt is allowed now; records it. Rejects on a database error. */
  allow(userId: string): Promise<boolean>;
}

/**
 * The `verification` identifier of a user's password attempts: `password-attempt:<hmac>`, keyed
 * by a key derived from the auth secret, so the table holds no user id. Account deletion uses it
 * to delete exactly these rows.
 */
export function passwordAttemptIdentifier(secret: string, userId: string): string {
  const key = createHmac("sha256", secret).update(`mitramatika:${LABEL}:v1`).digest();
  return `${LABEL}:` + createHmac("sha256", key).update(userId).digest("hex");
}

/**
 * The per-user attempt count, in Better Auth's `verification` table like the email send limit
 * (send-limit.ts): one row per attempt, expiring after the window. The attempt is recorded first
 * and then counted, so two parallel attempts cannot both slip under the limit; a refused attempt
 * counts too.
 */
export function createPasswordAttemptLimiter<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: PgAsyncDatabase<TQueryResult, TRelations>,
  secret: string,
  now: () => Date = () => new Date(),
): AttemptLimiter {
  return {
    async allow(userId) {
      const identifier = passwordAttemptIdentifier(secret, userId);
      const at = now();
      await db
        .delete(verification)
        .where(
          and(eq(verification.identifier, identifier), lte(verification.expiresAt, at)),
        );
      await db.insert(verification).values({
        identifier,
        value: "1",
        expiresAt: new Date(at.getTime() + PASSWORD_CHANGE_WINDOW_SECONDS * 1000),
      });
      const [live] = await db
        .select({ n: count() })
        .from(verification)
        .where(
          and(eq(verification.identifier, identifier), gt(verification.expiresAt, at)),
        );
      return live.n <= PASSWORD_CHANGE_ATTEMPTS;
    },
  };
}

export type PasswordChangeError =
  "wrongPassword" | "rateLimited" | "invalidInput" | "generic";

export interface PasswordChange {
  /** From the session only. */
  userId: string;
  currentPassword: string;
  newPassword: string;
}

/** The port's error as the account forms' error. */
export function passwordCheckError(code: AuthPortError["code"]): PasswordChangeError {
  switch (code) {
    case "wrong_password":
      return "wrongPassword";
    case "rate_limited":
      return "rateLimited";
    case "invalid_input":
      return "invalidInput";
    default:
      return "generic";
  }
}

/**
 * Asks Better Auth (through the port, so the per-IP and per-user limits apply) to change the
 * password. A wrong current password is reported as exactly that and nothing else.
 */
export async function changePasswordFor(
  deps: { port: AuthPort },
  { currentPassword, newPassword }: PasswordChange,
): Promise<Result<void, PasswordChangeError>> {
  try {
    const { error } = await deps.port.changePassword({ currentPassword, newPassword });
    if (!error) return ok();
    if (error.code === "unavailable") {
      logger.error(
        { module: "settings", operation: "changePassword", code: error.code },
        "settings: the password change failed",
      );
    }
    return err(passwordCheckError(error.code));
  } catch (error) {
    logger.error(
      { module: "settings", operation: "changePassword", err: error },
      "settings: the password change failed",
    );
    return err("generic");
  }
}
