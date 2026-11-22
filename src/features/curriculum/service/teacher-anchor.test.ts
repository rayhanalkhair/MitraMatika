import { describe, expect, it } from "vitest";
import { teacherSourceAnchor } from "./teacher-anchor";

const PYTHAGORAS =
  "CP Matematika Fase D (BSKAP 046/H/KR/2025), elemen Geometri; disebutkan konsisten pada kedua sumber sekunder pada docs/research/curriculum-sources.md. Kandidat topik irisan vertikal (B22, implementation-plan.md) - menunggu validasi P0-12 dan keputusan D-024.";

describe("teacherSourceAnchor", () => {
  it("keeps only the text before the first semicolon", () => {
    expect(teacherSourceAnchor(PYTHAGORAS)).toBe(
      "CP Matematika Fase D (BSKAP 046/H/KR/2025), elemen Geometri",
    );
  });

  it("returns a clean string without a semicolon as is, trimmed of a trailing period", () => {
    expect(teacherSourceAnchor("  CP Matematika Fase D, elemen Aljabar.  ")).toBe(
      "CP Matematika Fase D, elemen Aljabar",
    );
    expect(teacherSourceAnchor("hlm. 12")).toBe("hlm. 12");
  });

  it("returns undefined when the text mentions an internal marker", () => {
    expect(teacherSourceAnchor("Lihat docs/research/x")).toBeUndefined();
    expect(teacherSourceAnchor("catatan.md")).toBeUndefined();
    expect(teacherSourceAnchor("keputusan D-024")).toBeUndefined();
    expect(teacherSourceAnchor("menunggu P0-12")).toBeUndefined();
    expect(teacherSourceAnchor("kandidat B22 irisan")).toBeUndefined();
  });

  it("does not hide a citation that only resembles an internal marker", () => {
    expect(teacherSourceAnchor("CD-01 Matematika Fase D")).toBe(
      "CD-01 Matematika Fase D",
    );
    expect(teacherSourceAnchor("ISBN 978-B20, hlm. 4")).toBe("ISBN 978-B20, hlm. 4");
    expect(teacherSourceAnchor("Buku XP0-1 bab 2")).toBe("Buku XP0-1 bab 2");
  });

  it("returns undefined when the part before the semicolon is internal", () => {
    expect(teacherSourceAnchor("Lihat docs/research/x; CP Fase D")).toBeUndefined();
  });

  it("returns undefined for null, undefined and blank input", () => {
    expect(teacherSourceAnchor(null)).toBeUndefined();
    expect(teacherSourceAnchor(undefined)).toBeUndefined();
    expect(teacherSourceAnchor("  ; x")).toBeUndefined();
  });
});
