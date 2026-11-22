import { defineConfig, devices } from "@playwright/test";
import { assertLocalE2eDatabase } from "./scripts/e2e-guard";
import { E2E_RUNNER_SECRET, signedInState } from "./tests/e2e/auth";

// CI only: the dev server below runs with the scripted AI and a known runner secret, so refuse to even
// load this config unless DATABASE_URL is a local database and E2E_CI=1 (never staging).
assertLocalE2eDatabase(process.env);

// The generation specs share ONE fake user (one active request at a time), one scripted-AI
// scenario (on globalThis in the dev server) and one database, so they never overlap: a single
// worker for the whole run, and the spec files that create requests live in their own projects.
const GENERATION_SPECS = [
  "**/journey.spec.ts",
  "**/failures.spec.ts",
  "**/a11y.spec.ts",
  "**/daily-limit.spec.ts",
  "**/bank.spec.ts",
  "**/assessment.spec.ts",
  "**/materials.spec.ts",
  "**/solver.spec.ts",
];

const generationProject = {
  testMatch: GENERATION_SPECS,
  fullyParallel: false,
  // Generation waits up to 120 s, the retried malformed_twice job a little longer.
  timeout: 300_000,
  // A retry would start with the failed attempt's request still active, so there are none.
  retries: 0,
};

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  // Intentional and global: all specs share one fake user, one database and one dev server.
  workers: 1,
  forbidOnly: !!process.env.CI,
  // One retry in CI: a transient failure (a first dev-server compile) shows up as "flaky" in the
  // report instead of failing the job; a real failure still fails after the retry.
  retries: process.env.CI ? 1 : 0,
  // CI only: a broken page makes every test wait out its timeout (the first run burned 42 minutes),
  // so stop after a handful of failures instead of finishing the whole matrix.
  maxFailures: process.env.CI ? 5 : undefined,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    storageState: signedInState(),
  },
  projects: [
    {
      name: "android-chrome",
      testIgnore: GENERATION_SPECS,
      use: { ...devices["Pixel 7"] },
    },
    {
      name: "desktop-chromium",
      testIgnore: GENERATION_SPECS,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "journey-android",
      ...generationProject,
      use: { ...devices["Pixel 7"], trace: "retain-on-failure" },
    },
    {
      name: "journey-desktop",
      ...generationProject,
      use: { ...devices["Desktop Chrome"], trace: "retain-on-failure" },
    },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      E2E_FAKE_AUTH: "1",
      E2E_FAKE_AI: "1",
      E2E_CI: "1",
      // The CI job's local Postgres service (checked above).
      DATABASE_URL: process.env.DATABASE_URL ?? "",
      CRON_SECRET: E2E_RUNNER_SECRET,
      // TEST-ONLY dummy auth settings so tests/e2e/auth-routes.spec.ts can call the real
      // /api/auth route; no real secret or Google account is involved.
      BETTER_AUTH_SECRET: "e2e-test-only-secret-not-for-real-use!",
      BETTER_AUTH_URL: "http://localhost:3000",
      GOOGLE_CLIENT_ID: "e2e-test-only-google-client-id",
      GOOGLE_CLIENT_SECRET: "e2e-test-only-google-client-secret",
    },
  },
});
