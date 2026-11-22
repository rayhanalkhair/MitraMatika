import { availableParallelism } from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
    // Stability under load (four load failures so far: PGlite "unknown error, read", dynamic
    // import timeouts). PGlite is WASM, so child processes rather than worker threads; the worker
    // count is bounded so a busy machine does not starve each PGlite instance and import.
    pool: "forks",
    maxWorkers: Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))),
    testTimeout: 20_000,
    hookTimeout: 60_000,
    retry: process.env.CI ? 1 : 0,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // The guard throws outside the Next server bundle; tests run in plain Node.
      "server-only": path.resolve(import.meta.dirname, "src/test/empty-module.ts"),
    },
  },
});
