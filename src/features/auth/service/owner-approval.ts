import "server-only";
import { eq } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import { getDb } from "@/lib/db/runtime";
import { user } from "@/lib/db/schema";
import { isApprovedEmail } from "./approval";

/**
 * Whether the job runner may still run work for this owner: the owner's address is approved right
 * now (the environment is read on every call, so removing an address takes effect at the next job
 * step). A deleted owner, or one whose email is not verified, is not approved. Service connection
 * (RLS bypassed): the lookup is by primary key. Throws when the lookup itself fails; the runner
 * treats that as "cannot tell" and retries the job later instead of running it.
 */
export async function isOwnerApproved<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  ownerId: string,
  db: PgAsyncDatabase<TQueryResult, TRelations> = getDb() as unknown as PgAsyncDatabase<
    TQueryResult,
    TRelations
  >,
): Promise<boolean> {
  const rows = await db
    .select({ email: user.email, verified: user.emailVerified })
    .from(user)
    .where(eq(user.id, ownerId))
    .limit(1);
  const row = rows.at(0);
  return row !== undefined && row.verified && isApprovedEmail(row.email);
}
