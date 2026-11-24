import { describe, expect, it } from "vitest";
import { PROSE } from "../fixtures/ingest";
import {
  cleanPageText,
  MAX_PAGE_CHARS,
  MIN_TEXT_CHARS,
  pageQuality,
} from "./page-quality";

describe("pageQuality", () => {
  it("rates ordinary prose high with no flags", () => {
    expect(pageQuality(PROSE)).toEqual({ confidence: "high", flags: [] });
  });

  it("rates an empty or nearly empty page low (low_text)", () => {
    expect(pageQuality("")).toEqual({ confidence: "low", flags: ["low_text"] });
    expect(pageQuality("  \n Bab 1 \n 12 ")).toEqual({
      confidence: "low",
      flags: ["low_text"],
    });
  });

  it("keeps the 40-character floor: a scan whose only text is a running header is low and OCR-able", () => {
    expect(MIN_TEXT_CHARS).toBe(40);
    // About 25 letters and digits: a header and a page number over a scanned page.
    const headerOnly = "Matematika SMP Kelas VIII Bab 3\n42";
    expect(pageQuality(headerOnly)).toEqual({ confidence: "low", flags: ["low_text"] });
    // Short but over the floor (a title and two lines) is not flagged for its length.
    const shortPage =
      "Sistem persamaan linear dua variabel\nContoh: x + y = 5 dan x - y = 1";
    expect(pageQuality(shortPage)).toEqual({ confidence: "high", flags: [] });
  });

  it("rates text full of replacement or private-use characters low (garbled)", () => {
    const broken = PROSE.replace(/[aeiou]/g, "\ufffd");
    expect(pageQuality(broken)).toEqual({ confidence: "low", flags: ["garbled"] });
    const privateUse = PROSE.replace(/[aeiou]/g, "");
    expect(pageQuality(privateUse).flags).toContain("garbled");
  });

  it("rates text that is mostly symbols low (garbled): a font with a broken map", () => {
    const symbols = `${"!\"#%&'()*,./:;?@[]_{}".repeat(8)} ${PROSE.slice(0, 60)}`;
    expect(pageQuality(symbols)).toEqual({ confidence: "low", flags: ["garbled"] });
  });

  it("flags a text layer dense with formulas as formula_text (medium): their order is unreliable", () => {
    const formula = `${PROSE} Jadi x + y = 10, x − y = 2, 2x + 3y = 12, 4x − y = 7 dan x = 6.`;
    expect(pageQuality(formula)).toEqual({
      confidence: "medium",
      flags: ["formula_text"],
    });
    // A few simple equations in prose are not a scrambled formula: the smoke test's clean
    // SPLDV pages (two or three equations) were wrongly sent to review.
    expect(pageQuality(`${PROSE} Hasilnya 5 + 3 = 8.`).confidence).toBe("high");
    expect(
      pageQuality(`${PROSE} Jadi x + y = 10 dan x − y = 2, sehingga x = 6.`),
    ).toEqual({ confidence: "high", flags: [] });
  });

  it("does not count LaTeX that is already delimited as uncertain or garbled", () => {
    const docx = `${PROSE} Pecahan $\\frac{a}{b}$ dan $\\sqrt{x}$ serta $$\\left(a+b\\right)^{2}=a^{2}+2ab+b^{2}$$`;
    expect(pageQuality(docx)).toEqual({ confidence: "high", flags: [] });
  });

  it("keeps uncertain_math for the [[?]] marker only", () => {
    expect(pageQuality(`${PROSE} Matriks [[?]]1 2[[?]]`)).toEqual({
      confidence: "medium",
      flags: ["uncertain_math"],
    });
  });

  it("lists every flag that applies, low before medium", () => {
    expect(pageQuality("[[?]] \ufffd\ufffd")).toEqual({
      confidence: "low",
      flags: ["uncertain_math", "low_text"],
    });
  });
});

describe("cleanPageText", () => {
  it("replaces NUL and lone surrogates (Postgres text refuses them) and normalises newlines", () => {
    expect(cleanPageText("a\u0000b\ud800c\r\nd\re")).toBe("a\ufffdb\ufffdc\nd\ne");
  });

  it("keeps valid surrogate pairs", () => {
    expect(cleanPageText("x \u{1d465}")).toBe("x \u{1d465}");
  });

  it(`cuts a page at ${String(MAX_PAGE_CHARS)} characters`, () => {
    expect(cleanPageText("a".repeat(MAX_PAGE_CHARS + 10))).toHaveLength(MAX_PAGE_CHARS);
  });
});
