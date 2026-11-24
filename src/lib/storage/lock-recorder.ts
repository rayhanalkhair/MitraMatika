import { PgDialect } from "drizzle-orm/pg-core";

// Test support: records, in order, the advisory locks and lock timeouts that the transactions of
// a database take, so a test can assert a lock IS taken, how often, with which key and in which
// order relative to other events (PGlite runs transactions one after another, so a race test
// cannot show that a lock is missing; the recorded statements can).

const dialect = new PgDialect();

/**
 * A database whose transactions push `lock:<key>` for every pg_advisory_xact_lock (the bound key
 * for a per-owner lock, the SQL text for the inlined app-wide one) and `timeout:<value>` for
 * every `set local lock_timeout` into `events`, in the order they run. `before` runs ahead of
 * every statement with its SQL text and the transaction (it may throw, or run statements of its
 * own as a stand-in for a concurrent writer). Tests push their own
 * markers (for example "put") into the same array.
 */
export function recordLocks<T extends object>(
  db: T,
  events: string[],
  before?: (
    statement: string,
    tx: { execute: (query: unknown) => Promise<unknown> },
  ) => Promise<void>,
): T {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "transaction") return Reflect.get(target, prop, receiver) as unknown;
      return (callback: (tx: object) => Promise<unknown>, ...rest: unknown[]) =>
        (
          target as unknown as {
            transaction: (
              cb: (tx: object) => Promise<unknown>,
              ...r: unknown[]
            ) => unknown;
          }
        ).transaction(
          (tx) =>
            callback(
              new Proxy(tx, {
                get(inner, name, innerReceiver) {
                  if (name !== "execute") {
                    return Reflect.get(inner, name, innerReceiver) as unknown;
                  }
                  return async (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
                    const { sql: text, params } = dialect.sqlToQuery(query);
                    if (text.includes("pg_advisory_xact_lock")) {
                      events.push(`lock:${params.length > 0 ? String(params[0]) : text}`);
                    } else if (text.includes("lock_timeout")) {
                      events.push(
                        `timeout:${text.replace(/^set local lock_timeout = /, "")}`,
                      );
                    }
                    const raw = inner as { execute: (q: unknown) => Promise<unknown> };
                    await before?.(text, raw);
                    return raw.execute(query);
                  };
                },
              }),
            ),
          ...rest,
        );
    },
  });
}

/** The inlined SQL of the app-wide lock, as recordLocks reports it. */
export const APP_LOCK_EVENT =
  "lock:select pg_advisory_xact_lock(hashtextextended('app_storage_cap', 0))";

/** What Postgres throws when lock_timeout expires (SQLSTATE 55P03). */
export function lockTimeoutError(): Error {
  return Object.assign(new Error("canceling statement due to lock timeout"), {
    code: "55P03",
  });
}
