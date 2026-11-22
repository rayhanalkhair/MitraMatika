import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";
import { E2E_FAKE_USER } from "../src/features/auth/service/e2e-session";
import { runAsUser } from "../src/lib/db/client";
import { seedFakeUser } from "./e2e-user";

// Mirrors the CI e2e job: a stock Postgres with nothing pre-created is migrated with the real
// migrations, then the fake teacher is seeded.
describe("e2e database setup", () => {
  it("migrates an empty database, seeds the fake user and resolves auth.uid()", async () => {
    const client = new PGlite({ extensions: { pg_trgm } });
    const db = drizzle({ client });
    const migrationsFolder = join(process.cwd(), "drizzle");
    await migrate(db, { migrationsFolder });
    await migrate(db, { migrationsFolder }); // already applied: a no-op

    const run = (query: string, params: unknown[]) => client.query(query, params);
    const id = await seedFakeUser(run);
    await seedFakeUser(run); // ON CONFLICT DO NOTHING
    expect(id).toBe(E2E_FAKE_USER.id);

    const uid = await runAsUser(db, id, async (tx) => {
      const r = await tx.execute(sql`select auth.uid()::text as uid`);
      return (r.rows[0] as { uid: string }).uid;
    });
    expect(uid).toBe(id);

    const own = await runAsUser(db, id, async (tx) =>
      tx.execute(sql`select id from profiles`),
    );
    expect(own.rows).toHaveLength(1);
    await client.close();
  }, 60_000);
});
