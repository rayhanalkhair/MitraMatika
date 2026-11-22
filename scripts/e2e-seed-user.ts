import postgres from "postgres";
import { assertLocalE2eDatabase } from "./e2e-guard";
import { seedFakeUser } from "./e2e-user";

// CI-only: seeds the fake e2e teacher. Refuses anything but a local database with E2E_CI=1.
async function main(): Promise<void> {
  assertLocalE2eDatabase(process.env);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const id = await seedFakeUser((query, params) =>
      client.unsafe(query, params as postgres.ParameterOrJSON<never>[]),
    );
    console.log(`Pengguna e2e siap: ${id}`);
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
