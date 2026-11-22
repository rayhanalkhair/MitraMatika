import { createHmac } from "node:crypto";
import { and, count, eq, gt, lte } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import { verification } from "@/lib/db/schema";

/**
 * A `verification` identifier `<label>:<hmac>` for a subject (an address, an IP), keyed by a key
 * derived from the auth secret and the label, so the table never holds the subject itself and the
 * rows of two labels cannot be linked.
 */
export function hashedIdentifier(secret: string, label: string, subject: string): string {
  const key = createHmac("sha256", secret).update(`mitramatika:${label}:v1`).digest();
  return `${label}:` + createHmac("sha256", key).update(subject).digest("hex");
}

/**
 * Records one event under `identifier` (a `verification` row expiring at `expiresAt`) and returns
 * its row id and how many unexpired events the identifier now has, this one included. Recording
 * first and counting after means two parallel events cannot both slip under a limit. Expired rows
 * of the identifier are deleted first. Same storage as the email send limit (send-limit.ts).
 */
export async function recordEvent<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: PgAsyncDatabase<TQueryResult, TRelations>,
  identifier: string,
  at: Date,
  expiresAt: Date,
): Promise<{ id: string; live: number }> {
  await db
    .delete(verification)
    .where(and(eq(verification.identifier, identifier), lte(verification.expiresAt, at)));
  const [row] = await db
    .insert(verification)
    .values({ identifier, value: "1", expiresAt })
    .returning({ id: verification.id });
  const live = await countLive(db, identifier, at);
  return { id: row.id, live };
}

/** How many unexpired events `identifier` has at `at`. */
export async function countLive<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: PgAsyncDatabase<TQueryResult, TRelations>,
  identifier: string,
  at: Date,
): Promise<number> {
  const [live] = await db
    .select({ n: count() })
    .from(verification)
    .where(and(eq(verification.identifier, identifier), gt(verification.expiresAt, at)));
  return live.n;
}

/** Deletes one recorded event (a refused send must not use up a budget). */
export async function forgetEvent<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(db: PgAsyncDatabase<TQueryResult, TRelations>, id: string): Promise<void> {
  await db.delete(verification).where(eq(verification.id, id));
}
