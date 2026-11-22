import { describe, expect, it } from "vitest";
import { makeMetadataBombPdf, makePdf } from "../test-support";
import { inspectPdf, PDF_WORKER_LIMITS, PDF_WORKER_TIMEOUT_MS } from "./pdf-worker";

const encoder = new TextEncoder();

describe("inspectPdf (Ruling R10: in a bounded worker)", () => {
  it("uses bounded heaps and a hard timeout", () => {
    expect(PDF_WORKER_LIMITS).toEqual({
      maxOldGenerationSizeMb: 256,
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 4,
    });
    expect(PDF_WORKER_TIMEOUT_MS).toBe(20_000);
  });

  it("counts the pages of a PDF", async () => {
    expect(await inspectPdf(makePdf(4), { ownerId: "test-owner" })).toEqual({
      status: "ok",
      pages: 4,
    });
  });

  it("reports both kinds of encryption", async () => {
    expect(
      await inspectPdf(makePdf(1, { encrypt: true }), { ownerId: "test-owner" }),
    ).toEqual({
      status: "encrypted",
    });
    expect(
      await inspectPdf(makePdf(1, { encrypt: "ownerOnly" }), { ownerId: "test-owner" }),
    ).toEqual({
      status: "encrypted",
    });
  });

  it("reports garbage as damaged", async () => {
    expect(
      await inspectPdf(encoder.encode(`%PDF-1.4\n${"x".repeat(200)}`), {
        ownerId: "test-owner",
      }),
    ).toEqual({
      status: "damaged",
    });
  });

  it("maps a worker that runs out of time to damaged", async () => {
    expect(await inspectPdf(makePdf(1), { ownerId: "test-owner", timeoutMs: 1 })).toEqual(
      { status: "damaged" },
    );
  });

  it("does not inflate a metadata bomb and keeps the caller's memory bounded", async () => {
    // 1 GB of XMP metadata in a file of about 1 MB.
    const bomb = makeMetadataBombPdf(1024 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);
    // Peak resident memory of this process (KiB); a synchronous inflate blocks any sampler.
    const before = process.resourceUsage().maxRSS;
    const result = await inspectPdf(bomb, { ownerId: "test-owner" });
    expect(result).toEqual({ status: "ok", pages: 1 });
    expect(process.resourceUsage().maxRSS - before).toBeLessThan(300 * 1024);
  }, 60_000);
});
