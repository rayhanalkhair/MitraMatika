import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import id from "../../messages/id.json";

// The upload limits are 25 MB per file and 300 MB per teacher (ADR-0022). The numbers live in
// src/features/materials/schema/upload.ts; the copy must say the same, and no message may still
// name the old 50 MB or 1 GB limits.
const STALE = /\b50 ?MB\b|\b1 ?GB\b/;

describe("storage limit copy", () => {
  for (const [locale, messages] of [
    ["id", id],
    ["en", en],
  ] as const) {
    it(`${locale}: no message names the old 50 MB or 1 GB limits`, () => {
      expect(JSON.stringify(messages.materials)).not.toMatch(STALE);
      expect(JSON.stringify(messages)).not.toMatch(STALE);
    });
  }

  it("states 25 MB per file and 300 MB per teacher in both languages", () => {
    expect(id.materials.upload.hint).toContain("25 MB");
    expect(id.materials.upload.errors.size).toContain("25 MB");
    expect(id.materials.upload.errors.quota).toContain("300 MB");
    expect(en.materials.upload.hint).toContain("25 MB");
    expect(en.materials.upload.errors.size).toContain("25 MB");
    expect(en.materials.upload.errors.quota).toContain("300 MB");
  });
});
