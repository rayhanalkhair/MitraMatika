import { describe, expect, it } from "vitest";
import { buildSearchText, normaliseSearch } from "./search-text";

describe("normaliseSearch", () => {
  it("lower-cases, strips accents and collapses whitespace", () => {
    expect(normaliseSearch("  Café   ÉCOLE\nÑandú ")).toBe("cafe ecole nandu");
  });

  it("strips LaTeX commands and math delimiters but keeps the operands", () => {
    expect(normaliseSearch("Hitung $\\frac{1}{2} + \\sqrt{9}$")).toBe("hitung 1 2 + 9");
  });

  it("returns an empty string for empty or command-only text", () => {
    expect(normaliseSearch("")).toBe("");
    expect(normaliseSearch("$\\alpha$")).toBe("");
  });
});

describe("buildSearchText", () => {
  it("joins stem, options, explanation and TP codes, normalised", () => {
    const text = buildSearchText({
      stemMd: "Hasil dari $2 + 3$ adalah",
      options: [
        { label: "A", text_md: "Lima" },
        { label: "B", text_md: "ENAM" },
      ],
      explanationMd: "Jumlahkan **dua** dan tiga",
      objectiveCodes: ["TP-3", "TP-4"],
    });
    expect(text).toBe(
      "hasil dari 2 + 3 adalah lima enam jumlahkan **dua** dan tiga tp-3 tp-4",
    );
  });

  it("tolerates options that are not the expected shape", () => {
    expect(
      buildSearchText({
        stemMd: "Soal",
        options: null,
        explanationMd: "",
        objectiveCodes: [],
      }),
    ).toBe("soal");
  });
});
