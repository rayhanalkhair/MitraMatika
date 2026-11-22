import { describe, expect, it } from "vitest";
import {
  citationExcerpt,
  MAX_EXCERPT_CHARS,
  stripMarkers,
  validateCitations,
} from "./citations";

const IDS = ["P2", "P3", "P7"];

describe("validateCitations", () => {
  it("accepts ids that were provided, in any common spelling, without duplicates", () => {
    const result = validateCitations({ citations: ["P3", "[P7]", " p3 "] }, IDS);
    expect(result).toEqual({
      ok: true,
      data: [
        { passageId: "P3", page: 3 },
        { passageId: "P7", page: 7 },
      ],
    });
  });

  it("rejects an invented id even when the others are real", () => {
    expect(validateCitations({ citations: ["P3", "[P99]"] }, IDS)).toEqual({
      ok: false,
      error: "unknownCitation",
    });
  });

  it("rejects a question that cites nothing", () => {
    expect(validateCitations({ citations: [] }, IDS)).toEqual({
      ok: false,
      error: "unknownCitation",
    });
    expect(validateCitations({}, IDS)).toEqual({ ok: false, error: "unknownCitation" });
  });

  it("rejects ids that only look like passage ids", () => {
    for (const bad of ["P", "P3a", "hal. 3", "3", "P03x", "P-3"]) {
      expect(validateCitations({ citations: [bad] }, IDS).ok).toBe(false);
    }
  });
});

describe("excerpts", () => {
  it("drops the [[?]] markers and keeps the text between them", () => {
    expect(stripMarkers("Luas [[?]]$x^2$[[?]] cm")).toBe("Luas $x^2$ cm");
  });

  it("is at most 300 characters of the page text, markers and runs of space removed", () => {
    const page = `Judul\n\n[[?]]${"kata ".repeat(200)}[[?]]`;
    const excerpt = citationExcerpt(page);
    expect(excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    expect(MAX_EXCERPT_CHARS).toBe(300);
    expect(excerpt).not.toContain("[[?]]");
    expect(excerpt.startsWith("Judul kata kata")).toBe(true);
  });

  it("never leaves half a marker behind at the cut", () => {
    const page = `${"a".repeat(297)}[[?]]b[[?]]`;
    expect(citationExcerpt(page)).not.toMatch(/\[\[|\?\]\]/);
  });
});
