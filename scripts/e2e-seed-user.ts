import postgres from "postgres";
import { assertLocalE2eDatabase } from "./e2e-guard";
import { seedFakeAdminUser, seedFakePendingUser, seedFakeUser } from "./e2e-user";

// CI-only: seeds the fake e2e teacher and the pending account. Refuses anything but a local database with E2E_CI=1.
async function main(): Promise<void> {
  assertLocalE2eDatabase(process.env);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const run = (query: string, params: unknown[]) =>
      client.unsafe(query, params as postgres.ParameterOrJSON<never>[]);
    console.log(`Pengguna e2e siap: ${await seedFakeUser(run)}`);
    console.log(`Pengguna e2e menunggu siap: ${await seedFakePendingUser(run)}`);
    console.log(`Admin e2e siap: ${await seedFakeAdminUser(run)}`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    "Seed pengguna e2e gagal:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
