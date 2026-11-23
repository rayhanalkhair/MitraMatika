import { describe, expect, it } from "vitest";
import {
  MAX_TEMPLATES_PER_TEACHER,
  TEACHER_STORAGE_CAP_BYTES,
} from "@/lib/storage/limits";
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

// The app-wide cap (ADR-0022): the same refusal sentence is shown by the upload, the photo, the
// logo and the export, in both languages, with no argument (an ICU placeholder would need one).
describe("app-wide storage full copy", () => {
  for (const [locale, messages] of [
    ["id", id],
    ["en", en],
  ] as const) {
    it(`${locale}: every refusal says the storage is full, that the admin knows and to try later`, () => {
      const texts = [
        messages.materials.upload.errors.appFull,
        messages.solve.errors.appFull,
        messages.settings.templates.logo.errors.appFull,
        messages.assessments.export.errors.appFull,
      ];
      for (const text of texts) {
        expect(text).toContain("MitraMatika");
        expect(text).not.toContain("{");
        expect(text).toMatch(
          locale === "id" ? /Admin sudah diberi tahu/ : /admin has been told/,
        );
      }
    });
  }
});

// The per-teacher cap counts every kind of file and templates are limited per teacher (security
// review F1): the copy names the same numbers as the constants.
describe("per-teacher cap copy", () => {
  for (const [locale, messages] of [
    ["id", id],
    ["en", en],
  ] as const) {
    it(`${locale}: the quota sentence names 300 MB and the template limit names ${String(MAX_TEMPLATES_PER_TEACHER)}`, () => {
      const texts = [
        messages.solve.errors.quota,
        messages.assessments.export.errors.quota,
        messages.settings.templates.logo.errors.quota,
      ];
      for (const text of texts) {
        expect(text).toContain(`${String(TEACHER_STORAGE_CAP_BYTES / 1024 / 1024)} MB`);
        expect(text).not.toContain("{");
      }
      const tooMany = messages.settings.templates.formErrors.tooMany;
      expect(tooMany).toContain(String(MAX_TEMPLATES_PER_TEACHER));
      expect(tooMany).not.toContain("{");
    });
  }
});
