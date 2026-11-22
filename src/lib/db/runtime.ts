import "server-only";
import { requireDatabaseUrl } from "@/lib/env";
import { createDbClient } from "./client";

type RuntimeDb = ReturnType<typeof createDbClient>;

// Cached on globalThis so Next's dev-mode module reloads do not open a new pool each time.
const cache = globalThis as unknown as { __mitramatikaDb?: RuntimeDb };

/**
 * The service connection, from `DATABASE_URL`. It bypasses RLS, so every query written against it
 * must filter by `owner_id` explicitly (ADR-0005); use `runAsUser` for anything that should run
 * under RLS. Created on first use and cached on `globalThis`, so dev reloads do not open new pools.
 */
export function getDb(): RuntimeDb {
  // The sign-in audit write is awaited, so an unreachable pooler must not stall sign-in for
  // postgres.js's 30 s default connect timeout.
  cache.__mitramatikaDb ??= createDbClient(requireDatabaseUrl(), {
    max: 3,
    idle_timeout: 20,
    connect_timeout: 5,
    prepare: false,
  });
  return cache.__mitramatikaDb;
}

export function resetDbForTests(): void {
  delete cache.__mitramatikaDb;
}
