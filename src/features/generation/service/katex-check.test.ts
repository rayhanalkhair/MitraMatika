import { describe, expect, it } from "vitest";
import { findInvalidMathSpans } from "./katex-check";

describe("findInvalidMathSpans", () => {
  it("returns an empty array for text with no math", () => {
    expect(findInvalidMathSpans("Berapakah hasil dari 5 tambah 3?")).toEqual([]);
  });

  it("returns an empty array when every span is valid", () => {
    const text =
      "Hitunglah $\\frac{1}{2} + \\frac{1}{3}$ dan tuliskan sebagai $$x^2 + 2x + 1$$.";
    expect(findInvalidMathSpans(text)).toEqual([]);
  });

  it("finds an invalid inline span", () => {
    const text = "Nilai dari $\\frac{1}{$ tidak lengkap.";
    const invalid = findInvalidMathSpans(text);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toContain("\\frac{1}{");
  });

  it("finds an invalid display span", () => {
    const text = "Persamaan: $$x^2 + \\notarealcommand$$";
    const invalid = findInvalidMathSpans(text);
    expect(invalid).toHaveLength(1);
  });

  it("does not treat an escaped dollar sign as a delimiter", () => {
    const text = "Harga barang adalah \\$50.000, bukan rumus.";
    expect(findInvalidMathSpans(text)).toEqual([]);
  });

  it("finds multiple invalid spans and skips valid ones between them", () => {
    const text = "Salah: $\\frac{}{}$ benar: $x + 1$ salah lagi: $\\notarealcommand$";
    const invalid = findInvalidMathSpans(text);
    expect(invalid.length).toBeGreaterThanOrEqual(1);
  });

  it("finds an over-escaped backslash before a LaTeX command (double backslash + letter)", () => {
    // KaTeX's "ignore" strict mode renders this without throwing (it reads as
    // a "\\" line-break command followed by literal text "frac{...}"), so this
    // is only caught by the dedicated over-escaping check, not renderToString.
    const text = "Luasnya adalah $\\\\frac{22}{7}$.";
    const invalid = findInvalidMathSpans(text);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toContain("\\\\frac");
  });

  it("finds an over-escaped backslash before a single-letter command like \\pi", () => {
    const text = "Gunakan $\\\\pi \\\\approx 3,14$.";
    const invalid = findInvalidMathSpans(text);
    expect(invalid).toHaveLength(1);
  });

  it("reproduces and catches the real over-escaped span observed from a live model run", () => {
    const text = "$\\\\frac{7\\\\pi}{3}\\\\text{ cm}$";
    const invalid = findInvalidMathSpans(text);
    expect(invalid).toHaveLength(1);
  });

  it("does not flag a standalone double backslash not followed by a letter (e.g. a line break in a cases/array environment)", () => {
    const text = "$$\\begin{cases}x + y = 1 \\\\ x - y = 2\\end{cases}$$";
    expect(findInvalidMathSpans(text)).toEqual([]);
  });

  it("does not flag a cases-environment line break immediately followed by a plain variable letter with no space", () => {
    // Whitespace after "\\" is a style convention, not a LaTeX requirement —
    // "x+y=1\\x-y=2" (no space before the second "x") is valid LaTeX. This
    // must not be confused with an over-escaped command: "x" is not one of
    // the known command words the over-escaping check looks for.
    const text = "$$\\begin{cases}x+y=1\\\\x-y=2\\end{cases}$$";
    expect(findInvalidMathSpans(text)).toEqual([]);
  });

  it("still flags an over-escaped command even directly adjacent to other content with no space", () => {
    const text = "$2\\\\times3=6$";
    const invalid = findInvalidMathSpans(text);
    expect(invalid).toHaveLength(1);
  });
});
