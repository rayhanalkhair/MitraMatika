import { and, like, lt, or } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import { verification } from "@/lib/db/schema";

// The `verification` identifiers the app's own limits write (hashed keys, no address or IP):
// send-limit.ts, global-send-budget.ts, ip-daily-limit.ts, sign-in-limit.ts, password-change.ts.
// Each limit deletes the expired rows of one identifier only when that identifier is written
// again, so rows of addresses and IPs that never come back, and every past day's budget rows,
// would stay for ever (re-review N7). Better Auth's own rows (tokens, OAuth state) are left alone.
export const LIMIT_ROW_PREFIXES = [
  "email-sent:",
  "auth-email-day:",
  "admin-notice-day:",
  "sign-up-ip:",
  "reset-request-ip:",
  "verification-resend-ip:",
  "sign-in-failure:",
  "password-attempt:",
] as const;

// Rows are kept a day past their expiry, so a row is never deleted while a request that read it
// as live may still be counting.
const GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes the app's limit rows that expired more than a day before `now`. Service connection.
 * Returns how many rows were deleted.
 */
export async function pruneExpiredLimitRows<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(db: PgAsyncDatabase<TQueryResult, TRelations>, now: Date): Promise<number> {
  const rows = await db
    .delete(verification)
    .where(
      and(
        lt(verification.expiresAt, new Date(now.getTime() - GRACE_MS)),
        or(
          ...LIMIT_ROW_PREFIXES.map((prefix) =>
            like(verification.identifier, `${prefix}%`),
          ),
        ),
      ),
    )
    .returning({ id: verification.id });
  return rows.length;
}
