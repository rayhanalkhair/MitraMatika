import "server-only";
import { and, eq } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import { account, session, user } from "@/lib/db/schema";

/**
 * The pre-hijack guard (decision 5). Runs just before Better Auth links a Google account, whose
 * email Google reports verified, to an existing user found by that email. If that user's email is
 * not verified, nothing it holds is proven to belong to the mailbox owner: anyone can sign up with
 * any address and a password. So, in one transaction, the email is marked verified (Google has
 * just proven it) and every account (in practice the squatter's password) and every session of
 * the user is deleted. The Google owner then inherits no password and no session, and has to set
 * a password through the reset link if they want one. A verified or unknown user is left
 * untouched; the conditional update makes a concurrent verification win cleanly. Auth tables are
 * written with the service connection, like the rest of auth.
 */
export async function prepareGoogleLink<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: PgAsyncDatabase<TQueryResult, TRelations>,
  { userId }: { userId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const promoted = await tx
      .update(user)
      .set({ emailVerified: true })
      .where(and(eq(user.id, userId), eq(user.emailVerified, false)))
      .returning({ id: user.id });
    if (promoted.length === 0) return;
    await tx.delete(account).where(eq(account.userId, userId));
    await tx.delete(session).where(eq(session.userId, userId));
  });
}
