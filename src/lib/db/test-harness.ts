import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { relations } from "./relations";

export const USER_A = "11111111-1111-1111-1111-111111111111";
export const USER_B = "22222222-2222-2222-2222-222222222222";

export const MIGRATIONS_FOLDER = join(process.cwd(), "drizzle");

// Building the full harness (PGlite + every migration) takes seconds, and several test files do it in
// parallel workers, so tests that call createTestDatabase pass this explicit per-test timeout
// instead of relying on vitest's 5s default.
export const DB_TEST_TIMEOUT = 60_000;

// A fresh in-process Postgres with nothing pre-created: the migrations themselves create the
// `authenticated` role, the auth schema and auth.uid(), exactly as on a stock Postgres in CI or a
// new Neon branch. The base connection stays the `postgres` superuser (the table owner), like
// production's DATABASE_URL: it bypasses RLS, which is what the service path does.
export async function createTestDatabase() {
  const client = new PGlite({ extensions: { pg_trgm } });
  const db = drizzle({ client, relations });

  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  // A role that is a member of `authenticated`, like an application role would be.
  await db.execute(sql`create role app_user`);
  await db.execute(sql`grant authenticated to app_user`);

  await db.execute(
    sql`insert into "user" (id, name, email, email_verified)
        values (${USER_A}, 'Teacher A', 'a@example.test', true),
               (${USER_B}, 'Teacher B', 'b@example.test', true)`,
  );
  await db.execute(
    sql`insert into profiles (id, display_name) values (${USER_A}, 'Teacher A'), (${USER_B}, 'Teacher B')`,
  );

  return { db, client };
}

export type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;
