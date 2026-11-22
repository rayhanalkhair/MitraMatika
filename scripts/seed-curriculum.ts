import { resolve } from "node:path";
import { createDbClient } from "../src/lib/db/client";
import { requireDatabaseUrl } from "../src/lib/env";
import { loadSeedFromFile } from "../src/features/curriculum/service/load-seed";
import {
  describeTarget,
  formatResult,
  parseSeedArgs,
} from "../src/features/curriculum/service/seed-cli";
import {
  SeedConflictError,
  writeSeed,
} from "../src/features/curriculum/service/seed-writer";

async function main(): Promise<void> {
  // npm swallows --dry-run / --activate and exposes them as npm_config_*; pnpm passes them through.
  if (process.env.npm_config_dry_run || process.env.npm_config_activate) {
    console.error(
      "Opsi tertelan oleh npm. Jalankan dengan pnpm, misalnya: pnpm db:seed:curriculum --dry-run",
    );
    process.exitCode = 1;
    return;
  }

  const parsedArgs = parseSeedArgs(process.argv.slice(2));
  if (!parsedArgs.ok) {
    console.error(parsedArgs.error);
    process.exitCode = 1;
    return;
  }
  const args = parsedArgs.data;

  // Validates the file (zod schema and cross-references) before any database connection.
  const seed = loadSeedFromFile(resolve(process.cwd(), args.file));

  const url = requireDatabaseUrl();
  console.log(`Basis data tujuan: ${describeTarget(url)}`);
  console.log(`Berkas seed: ${args.file}`);

  const db = createDbClient(url, { max: 1 });
  try {
    const result = await writeSeed(db, seed, {
      activate: args.activate,
      dryRun: args.dryRun,
    });
    for (const line of formatResult(result, { dryRun: args.dryRun })) console.log(line);
  } catch (error) {
    if (error instanceof SeedConflictError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    // drizzle-orm sets `$client` at runtime, but createDbClient's declared return type omits it.
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    "Memuat seed kurikulum gagal:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
