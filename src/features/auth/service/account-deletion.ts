import { createHmac } from "node:crypto";
import { and, count, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT, PgTable } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import {
  account,
  aiCalls,
  auditLog,
  generationRequests,
  generationRuns,
  jobRuns,
  jobs,
  questions,
  questionVersions,
  session,
  user,
  verification,
  verificationRuns,
} from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { err, ok, type Result } from "@/lib/result";
import type { AuthPort } from "./auth-port";
import { passwordAttemptIdentifier, passwordCheckError } from "./password-change";
import { sendLimitIdentifiers } from "./send-limit";
import { signInFailureIdentifier } from "./sign-in-limit";

export const AUDIT_ACCOUNT_DELETED = "account_deleted";

/** How many rows of each kind went with the account. */
export interface AccountDeletionCounts {
  sessions: number;
  accounts: number;
  questions: number;
  questionVersions: number;
  verificationRuns: number;
  generationRequests: number;
  generationRuns: number;
  jobs: number;
  aiCalls: number;
}

/**
 * The only identifier the deletion's audit entry keeps (ruling S12): an HMAC of the account id,
 * keyed by a key derived from the auth secret for this purpose alone. Whoever holds the secret
 * and an id from an abuse report can recognise the entry; the table alone reveals nothing.
 */
export function auditSubject(secret: string, userId: string): string {
  const key = createHmac("sha256", secret)
    .update("mitramatika:audit-account-deleted:v1")
    .digest();
  return createHmac("sha256", key).update(userId).digest("hex");
}

/**
 * Deletes the account `userId` and everything it owns (decision 9), in one transaction on the
 * service connection, so it happens completely or not at all:
 * - Better Auth's `verification` rows of the account, which have no foreign key, are deleted by
 *   exact match only (ruling S13): the address as identifier, any row whose value is exactly the
 *   id (Better Auth's reset tokens, stored under a hashed identifier),
 *   the app's hashed send-limit and password-attempt rows (built with the same helpers), and JSON
 *   state rows whose parsed `userId` or `link.userId` is the id. Nothing is matched by substring.
 * - `job_runs` rows carrying the owner are deleted explicitly (owner_id has no foreign key; they
 *   also go with their job).
 * - Deleting the `user` row cascades to its sessions, accounts and profile, and from the profile
 *   to every owned table. `app_errors` and `audit_log` rows are kept unlinked (ON DELETE SET NULL).
 * - One `audit_log` entry records the deletion: the counts and auditSubject, no owner.
 * The address must be the account's own (the caller passes the session's), otherwise nothing
 * happens. account-deletion.test.ts checks every table of the schema afterwards.
 */
export async function deleteAccountData<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: PgAsyncDatabase<TQueryResult, TRelations>,
  { userId, email, secret }: { userId: string; email: string; secret: string },
): Promise<Result<AccountDeletionCounts, "notFound">> {
  return db.transaction(async (tx) => {
    // Locks the row: a concurrent sign-in or second deletion waits for this one.
    const found = await tx
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.id, userId), eq(user.email, email)))
      .for("update");
    if (found.length === 0) return err("notFound");

    const countWhere = async (table: PgTable, where: SQL | undefined) => {
      const [row] = await tx.select({ n: count() }).from(table).where(where);
      return row.n;
    };
    const counts: AccountDeletionCounts = {
      sessions: await countWhere(session, eq(session.userId, userId)),
      accounts: await countWhere(account, eq(account.userId, userId)),
      questions: await countWhere(questions, eq(questions.ownerId, userId)),
      questionVersions: await countWhere(
        questionVersions,
        eq(questionVersions.ownerId, userId),
      ),
      verificationRuns: await countWhere(
        verificationRuns,
        eq(verificationRuns.ownerId, userId),
      ),
      generationRequests: await countWhere(
        generationRequests,
        eq(generationRequests.ownerId, userId),
      ),
      generationRuns: await countWhere(
        generationRuns,
        eq(generationRuns.ownerId, userId),
      ),
      jobs: await countWhere(jobs, eq(jobs.ownerId, userId)),
      aiCalls: await countWhere(aiCalls, eq(aiCalls.ownerId, userId)),
    };

    // JSON state rows only: anything that is not valid JSON is never cast.
    const jsonField = (path: SQL) =>
      sql`(case when pg_input_is_valid(${verification.value}, 'jsonb')
            then ${path} end) = ${userId}`;
    await tx.delete(verification).where(
      or(
        eq(verification.identifier, email),
        // Better Auth's reset tokens: the identifier is a hash of the token (no readable
        // prefix), the value is exactly the user id.
        eq(verification.value, userId),
        inArray(verification.identifier, [
          ...sendLimitIdentifiers(secret, email),
          passwordAttemptIdentifier(secret, userId),
          signInFailureIdentifier(secret, email),
        ]),
        jsonField(sql`${verification.value}::jsonb ->> 'userId'`),
        jsonField(sql`${verification.value}::jsonb -> 'link' ->> 'userId'`),
      ),
    );
    await tx.delete(jobRuns).where(eq(jobRuns.ownerId, userId));
    await tx.delete(user).where(eq(user.id, userId));
    await tx.insert(auditLog).values({
      ownerId: null,
      action: AUDIT_ACCOUNT_DELETED,
      metadata: { ...counts, subject: auditSubject(secret, userId) },
    });
    return ok(counts);
  });
}

// A Google-only account has no password to confirm; its session must be this recent instead
// (ruling S11).
export const DELETION_REAUTH_WINDOW_MS = 10 * 60 * 1000;

export type AccountDeletionError =
  | "passwordRequired"
  | "wrongPassword"
  | "rateLimited"
  | "signInAgain"
  | "notFound"
  | "generic";

export interface AccountDeletionRequest {
  /** From the session only. */
  userId: string;
  email: string;
  sessionCreatedAt?: Date | null;
  /** Typed in the dialog; needed only by an account with a password. */
  currentPassword: string;
}

export interface AccountDeletionDeps {
  port: AuthPort;
  /** Whether the account has a password; null when there is no such account. */
  hasPassword: (userId: string) => Promise<boolean | null>;
  deleteData: (owner: {
    userId: string;
    email: string;
  }) => Promise<Result<AccountDeletionCounts, "notFound">>;
  /**
   * Deletes the account's stored files (logos, exports) once its rows are gone (account-files.ts).
   * Best effort: a throw is logged and the deletion still succeeds.
   */
  deleteFiles?: (userId: string) => Promise<unknown>;
  now?: () => number;
}

/**
 * A fresh credential, then the deletion (ruling S11): an account with a password confirms it
 * (Better Auth's /verify-password through the port, so the per-IP and per-user attempt limits
 * apply); an account without one needs a session started in the last 10 minutes.
 */
export async function deleteAccountFor(
  deps: AccountDeletionDeps,
  request: AccountDeletionRequest,
): Promise<Result<void, AccountDeletionError>> {
  const { userId, email, sessionCreatedAt, currentPassword } = request;
  try {
    const withPassword = await deps.hasPassword(userId);
    if (withPassword === null) return err("notFound");
    if (withPassword) {
      if (currentPassword === "") return err("passwordRequired");
      const { error } = await deps.port.verifyPassword({ password: currentPassword });
      if (error) {
        const mapped = passwordCheckError(error.code);
        if (mapped === "generic") {
          logger.error(
            { module: "settings", operation: "deleteAccount", code: error.code },
            "settings: the password check before an account deletion failed",
          );
        }
        // A password over the length limit is simply not the account's password.
        return err(mapped === "invalidInput" ? "wrongPassword" : mapped);
      }
    } else {
      const now = deps.now?.() ?? Date.now();
      const created = sessionCreatedAt?.getTime();
      if (created === undefined || now - created > DELETION_REAUTH_WINDOW_MS) {
        return err("signInAgain");
      }
    }
    const deleted = await deps.deleteData({ userId, email });
    if (!deleted.ok) {
      logger.warn(
        { module: "settings", operation: "deleteAccount", code: deleted.error },
        "settings: the account to delete was not found",
      );
      return err("notFound");
    }
    // After the commit: the store cannot join the transaction, and a failure here must not undo
    // or fail a deletion that already happened.
    try {
      await deps.deleteFiles?.(userId);
    } catch (error) {
      logger.error(
        { module: "settings", operation: "deleteAccountFiles", err: error },
        "settings: the stored files of a deleted account could not be removed",
      );
    }
    return ok();
  } catch (error) {
    logger.error(
      { module: "settings", operation: "deleteAccount", err: error },
      "settings: the account deletion failed",
    );
    return err("generic");
  }
}
