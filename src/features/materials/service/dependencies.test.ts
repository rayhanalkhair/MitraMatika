import { describe, expect, it, vi } from "vitest";
import { runBoundedWorker } from "./bounded-worker";
import { ingestDependenciesAvailable, INGEST_PACKAGES } from "./dependencies";

describe("ingestDependenciesAvailable (Ruling R15)", () => {
  it("names the packages each parsing worker imports", () => {
    expect(INGEST_PACKAGES).toEqual({
      pdf: ["unpdf"],
      docx: ["jszip", "mammoth", "saxes"],
      image: [],
    });
  });

  it("finds the packages where the workers run (here: the project's node_modules)", async () => {
    expect(await ingestDependenciesAvailable("pdf", "test-owner")).toBe(true);
    expect(await ingestDependenciesAvailable("docx", "test-owner")).toBe(true);
    expect(await ingestDependenciesAvailable("image", "test-owner")).toBe(true);
  }, 30_000);

  it("reports a package that cannot be loaded from the workers' folder", async () => {
    const result = await runBoundedWorker(new URL("./deps.worker.mjs", import.meta.url), {
      ownerId: "test-owner",
      data: { packages: ["saxes", "no-such-package-mitramatika"] },
      timeoutMs: 15_000,
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
    });
    expect(result).toEqual({
      ok: true,
      value: { missing: ["no-such-package-mitramatika"] },
    });
  }, 30_000);

  it("says busy at once, not missing, when another parse holds the slot (never waits in the queue)", async () => {
    vi.resetModules();
    const fresh = await import("./dependencies");
    const worker = await import("./bounded-worker");
    const held = worker.runBoundedWorker(
      new URL("../fixtures/spin.worker.mjs", import.meta.url),
      {
        ownerId: "another-teacher",
        data: {},
        timeoutMs: 1_000,
        resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 },
      },
    );
    const started = Date.now();
    expect(await fresh.ingestDependenciesAvailable("pdf", "test-owner")).toBe("busy");
    expect(Date.now() - started).toBeLessThan(200);
    await held;
  }, 30_000);
});
