import { assertLocalE2eDatabase } from "./e2e-guard";

// First step of e2e:prepare and of the CI workflow: fails closed on a mis-set DATABASE_URL.
try {
  assertLocalE2eDatabase(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
