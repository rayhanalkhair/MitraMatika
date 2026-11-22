import { describe, expect, it } from "vitest";
import { breakOverwideWords, charWidthEm, estimateWidth } from "./text-width";

const TIMES = "Times-Roman";

describe("estimateWidth", () => {
  it("knows wide and narrow letters", () => {
    expect(charWidthEm("W", TIMES)).toBeGreaterThan(charWidthEm("i", TIMES) * 3);
    expect(estimateWidth("WWWW", TIMES, 12)).toBeCloseTo(0.944 * 4 * 12, 5);
    expect(charWidthEm("a", "Courier")).toBe(0.6);
    expect(charWidthEm("W", "Helvetica-Bold")).toBeGreaterThan(
      charWidthEm("W", "Helvetica"),
    );
  });

  it("is generous for characters outside the tables", () => {
    expect(charWidthEm("é", TIMES)).toBeGreaterThan(0.5);
  });
});

describe("breakOverwideWords", () => {
  it("returns text that fits as it is, spaces and all", () => {
    expect(breakOverwideWords("Luas persegi  panjang", TIMES, 12, 400)).toEqual([
      "Luas persegi  panjang",
    ]);
  });

  it("leaves a long word that still fits the column whole", () => {
    const word = "ketidakseimbangan";
    expect(breakOverwideWords(`a ${word} b`, TIMES, 12, 120)).toEqual([`a ${word} b`]);
  });

  it("cuts a word wider than the column into pieces that each fit", () => {
    const width = 86;
    const parts = breakOverwideWords("W".repeat(40), TIMES, 12, width);
    expect(parts.length).toBeGreaterThan(4);
    expect(parts.join("")).toBe("W".repeat(40));
    for (const part of parts)
      expect(estimateWidth(part, TIMES, 12)).toBeLessThanOrEqual(width);
  });

  it("keeps the words around the long one, in order", () => {
    const parts = breakOverwideWords(`awal ${"b".repeat(200)} akhir`, TIMES, 12, 100);
    expect(parts[0].startsWith("awal b")).toBe(true);
    expect(parts.at(-1)?.endsWith(" akhir")).toBe(true);
    expect(parts.join("")).toBe(`awal ${"b".repeat(200)} akhir`);
    for (const part of parts.slice(1, -1)) {
      expect(estimateWidth(part, TIMES, 12)).toBeLessThanOrEqual(100);
    }
  });

  it("handles a column of no width without looping", () => {
    expect(breakOverwideWords("abc", TIMES, 12, 0)).toEqual(["abc"]);
    expect(breakOverwideWords("", TIMES, 12, 50)).toEqual([""]);
  });
});

describe("Liberation faces", () => {
  it("estimates the bold faces wider than the regular ones", () => {
    expect(charWidthEm("W", "LiberationSerif-Bold")).toBeGreaterThan(
      charWidthEm("W", "LiberationSerif"),
    );
    expect(charWidthEm("W", "LiberationSans-Bold")).toBeGreaterThan(
      charWidthEm("W", "LiberationSans"),
    );
    expect(charWidthEm("W", "LiberationSans-BoldItalic")).toBeGreaterThan(
      charWidthEm("W", "LiberationSans-Italic"),
    );
  });
});

describe("family mapping", () => {
  it("uses the Helvetica widths for sans families and the Times widths for the rest", () => {
    const helvetica = charWidthEm("a", "Helvetica");
    expect(charWidthEm("a", "Arial")).toBe(helvetica);
    expect(charWidthEm("a", "LiberationSans")).toBe(helvetica);
    expect(helvetica).toBeGreaterThan(charWidthEm("a", "Times-Roman"));
    expect(charWidthEm("a", "LiberationSerif")).toBe(charWidthEm("a", "Times-Roman"));
    expect(charWidthEm("a", "KaTeXMain")).toBe(charWidthEm("a", "Times-Roman"));
  });
});
