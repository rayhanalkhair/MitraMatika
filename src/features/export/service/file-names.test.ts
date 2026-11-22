import { describe, expect, it } from "vitest";
import { assertSafeDownloadName, assertSafeKey } from "@/lib/storage/types";
import {
  downloadName,
  EXPORT_FILES,
  exportObjectKey,
  exportPrefix,
  titleStem,
} from "./file-names";

const OWNER = "11111111-1111-4111-8111-111111111111";
const JOB = "33333333-3333-4333-8333-333333333333";

describe("titleStem", () => {
  it.each([
    ["Ulangan Bab 1: Bilangan Bulat", "ulangan-bab-1-bilangan-bulat"],
    ["  Latihan Éxponen & Akar ✓ ", "latihan-exponen-akar"],
    ["../../etc/passwd", "etc-passwd"],
    ['Soal "kuis" <b>', "soal-kuis-b"],
    ["✓✓✓", "asesmen"],
    ["", "asesmen"],
    ["a".repeat(80), "a".repeat(60)],
    [`${"a".repeat(59)} b`, "a".repeat(59)],
  ])("%j -> %j", (title, stem) => {
    expect(titleStem(title)).toBe(stem);
  });
});

describe("downloadName", () => {
  it("names each document and the ZIP, always a safe attachment name", () => {
    const names = EXPORT_FILES.map((file) => downloadName("Ulangan Bab 1", file));
    expect(names).toEqual([
      "ulangan-bab-1-naskah-soal.pdf",
      "ulangan-bab-1-naskah-soal.docx",
      "ulangan-bab-1-kunci-jawaban.pdf",
      "ulangan-bab-1-kunci-jawaban.docx",
      "ulangan-bab-1-pembahasan.pdf",
      "ulangan-bab-1-pembahasan.docx",
      "ulangan-bab-1.zip",
    ]);
    for (const title of ['"; filename=evil.exe', "\r\nX: y", "ü".repeat(200)]) {
      for (const file of EXPORT_FILES) {
        expect(() => {
          assertSafeDownloadName(downloadName(title, file));
        }).not.toThrow();
      }
    }
  });
});

describe("export keys", () => {
  it("hold ids only and are safe keys", () => {
    expect(exportPrefix(OWNER, JOB)).toBe(`exports/${OWNER}/${JOB}/`);
    for (const file of EXPORT_FILES) {
      const key = exportObjectKey(OWNER, JOB, file);
      expect(() => {
        assertSafeKey(key);
      }).not.toThrow();
      expect(key.startsWith(exportPrefix(OWNER, JOB))).toBe(true);
    }
    expect(exportObjectKey(OWNER, JOB, { document: "zip", format: "zip" })).toMatch(
      /bundle\.zip$/,
    );
  });

  it("refuses anything but ids", () => {
    expect(() => exportPrefix("a@b.c", JOB)).toThrow();
    expect(() => exportPrefix(OWNER, "../x")).toThrow();
  });
});
