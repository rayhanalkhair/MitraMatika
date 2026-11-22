import { sql } from "drizzle-orm";
import type {
  PgAsyncDatabase,
  PgAsyncTransaction,
  PgQueryResultHKT,
} from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import type { AnyRelations } from "drizzle-orm/relations";
import postgres from "postgres";
import { err, ok, type Result } from "@/lib/result";
import { relations } from "./relations";

export function createDbClient(
  connectionString: string,
  options: postgres.Options<Record<string, postgres.PostgresType>> = {},
) {
  const client = postgres(connectionString, options);
  return drizzle({ client, relations });
}

export type DbConnectionCheck = Result<{ latencyMs: number }>;

/**
 * Connectivity probe for /api/health. Opens its own short-lived connection and always closes it,
 * so a health check hit repeatedly never leaks connections. Never throws: the outcome is
 * `ok({ latencyMs })` or `err(message)`.
 */
export async function checkDbConnection(
  connectionString: string,
): Promise<DbConnectionCheck> {
  const start = Date.now();
  // `postgres(...)` itself can throw (e.g. a malformed URL, or an unencoded
  // `%` in the password breaking its internal decodeURIComponent call), so
  // the constructor has to be inside the try for this function to keep its
  // "never throws" guarantee.
  let client: ReturnType<typeof postgres> | undefined;
  try {
    client = postgres(connectionString, { max: 1, connect_timeout: 10 });
    await client`select 1`;
    return ok({ latencyMs: Date.now() - start });
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  } finally {
    await client?.end();
  }
}

/**
 * Runs `fn` in one transaction as the Postgres role `authenticated` with the JWT subject set to
 * `userId`, so RLS applies to every statement in it. Rolls back if `fn` throws. Use it for
 * teacher-owned data; the service connection (`getDb()`) bypasses RLS and must filter by owner_id.
 * Typed against Drizzle's shared base types so it works for both postgres-js and PGlite.
 */
export async function runAsUser<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
  T,
>(
  db: PgAsyncDatabase<TQueryResult, TRelations>,
  userId: string,
  fn: (tx: PgAsyncTransaction<TQueryResult, TRelations>) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role authenticated`);
    await tx.execute(sql`select set_config('request.jwt.claim.sub', ${userId}, true)`);
    return fn(tx);
  });
}
