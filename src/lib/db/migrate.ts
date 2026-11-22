import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { requireDatabaseUrl } from "../env";

function describeTarget(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return "(URL basis data tidak dapat diuraikan)";
  }
}

async function main() {
  let connectionString: string;
  try {
    connectionString = requireDatabaseUrl();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  console.log(`Target basis data: ${describeTarget(connectionString)}`);

  // Runs against a stock Postgres with nothing pre-created: the first migration creates the
  // `authenticated` role, the auth schema and auth.uid() itself. Prepared statements are off so
  // a pooled (transaction-mode) connection string works as well as a direct one.
  const client = postgres(connectionString, { max: 1, prepare: false });
  const db = drizzle({ client });

  try {
    console.log("Menjalankan migrasi yang tertunda...");
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("Migrasi selesai.");
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error("Migrasi gagal:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
