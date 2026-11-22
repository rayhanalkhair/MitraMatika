import { and, eq, exists, inArray, lt, ne, not, or, sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import { account, session, user, verification } from "@/lib/db/schema";

// An email and password sign-up that was never verified within this time is deleted (final review
// I2): it frees an address someone squatted with a password and bounds how many unverified rows a
// sign-up flood leaves behind. A verification link lives 24 hours, so a week is generous.
export const UNVERIFIED_ACCOUNT_MAX_AGE_DAYS = 7;
// At most this many users per run (the daily run works through a backlog), which also keeps
// the statements well under PostgreSQL's limit on bound parameters.
export const PRUNE_BATCH_SIZE = 500;

/**
 * Deletes every user whose email is not verified and who was created more than
 * UNVERIFIED_ACCOUNT_MAX_AGE_DAYS before `now`, with their rows: the `user` row cascades to the
 * credential account, any session and the profile (and anything owned through it, which an
 * unverified user cannot have: it never gets a session). Their `verification` rows are deleted by
 * exact match (identifier = the address, value = the user id, or a JSON state row naming the id);
 * hashed limit rows have no address and expire on their own. A verified user is never touched:
 * the delete itself re-checks `email_verified = false`. A user with any session or any account
 * other than the password one (a Google link) is skipped too, although the auth hooks never let
 * an unverified user have either (re-review N3: checked, not assumed). At most `limit` users per
 * call. Service connection (RLS bypassed). Returns how many users were deleted.
 */
export async function pruneUnverifiedUsers<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: PgAsyncDatabase<TQueryResult, TRelations>,
  now: Date,
  { limit = PRUNE_BATCH_SIZE }: { limit?: number } = {},
): Promise<number> {
  const cutoff = new Date(now.getTime() - UNVERIFIED_ACCOUNT_MAX_AGE_DAYS * 86_400_000);
  return db.transaction(async (tx) => {
    const stale = and(
      eq(user.emailVerified, false),
      lt(user.createdAt, cutoff),
      not(
        exists(
          tx
            .select({ one: sql`1` })
            .from(session)
            .where(eq(session.userId, user.id)),
        ),
      ),
      not(
        exists(
          tx
            .select({ one: sql`1` })
            .from(account)
            .where(
              and(eq(account.userId, user.id), ne(account.providerId, "credential")),
            ),
        ),
      ),
    );
    const found = await tx
      .select({ id: user.id, email: user.email })
      .from(user)
      .where(stale)
      .orderBy(user.createdAt)
      .limit(limit)
      .for("update", { skipLocked: true });
    if (found.length === 0) return 0;
    const ids = found.map((row) => row.id);
    const jsonUserId = (path: ReturnType<typeof sql>) =>
      sql`(case when pg_input_is_valid(${verification.value}, 'jsonb')
            then ${path} end) in (${sql.join(
              ids.map((id) => sql`${id}`),
              sql`, `,
            )})`;
    await tx.delete(verification).where(
      or(
        inArray(
          verification.identifier,
          found.map((row) => row.email),
        ),
        inArray(verification.value, ids),
        jsonUserId(sql`${verification.value}::jsonb ->> 'userId'`),
        jsonUserId(sql`${verification.value}::jsonb -> 'link' ->> 'userId'`),
      ),
    );
    const deleted = await tx
      .delete(user)
      .where(and(inArray(user.id, ids), stale))
      .returning({ id: user.id });
    return deleted.length;
  });
}
