import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildDocumentModel } from "./document-model";
import { snapshot, template, version } from "../test-support";
import { renderDocxDocument } from "./render-docx";
import { renderDocument } from "./render-html";
import { cutText, NOT_XML_CHAR, xmlSafe } from "./xml";

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("xmlSafe", () => {
  it("drops the characters XML 1.0 forbids and keeps the rest", () => {
    // Code points built at run time: written as literals, the formatter turns them into raw
    // invisible characters.
    const c = (code: number) => String.fromCodePoint(code);
    const bad = [
      "a",
      c(0),
      "b",
      c(8),
      "c",
      c(0xb),
      "d",
      c(0xfffe),
      "e",
      c(0xffff),
      "f",
    ].join("");
    expect(xmlSafe(`${bad}${String.fromCharCode(0xd800)}g`)).toBe("abcdefg");
    const good = `tab\tlf\ncr\r ${c(0xd7ff)}${c(0xe000)}${c(0xfffd)}${c(0x1f600)}`;
    expect(xmlSafe(good)).toBe(good);
    expect(NOT_XML_CHAR.test("\u0001")).toBe(true);
    expect(NOT_XML_CHAR.test("a")).toBe(false);
  });
});

describe("cutText", () => {
  it("cuts by code points, never inside a surrogate pair", () => {
    const text = `${"x".repeat(119)}\u{1F600}yy`;
    const cut = cutText(text, 120);
    expect(cut).toBe(`${"x".repeat(119)}\u{1F600}...`);
    expect(cut).not.toMatch(LONE_SURROGATE);
    expect(cutText("short", 120)).toBe("short");
    expect(cutText("x".repeat(120), 120)).toBe("x".repeat(120));
  });
});

describe("warning sources", () => {
  const source = `\\bad ${"x".repeat(114)}\u{1F600}tail`;

  it("never end in half a surrogate pair (DOCX)", async () => {
    const doc = buildDocumentModel(
      snapshot({}, { i1: version(`Soal $${source}$`) }),
      template,
    );
    const { warnings } = await renderDocxDocument(doc, "paper", {
      paper: "A4",
      font: "times",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].source).not.toMatch(LONE_SURROGATE);
    expect(warnings[0].source.endsWith("\u{1F600}...")).toBe(true);
    expect(JSON.parse(JSON.stringify(warnings))).toEqual(warnings);
  });

  it("never end in half a surrogate pair (HTML)", () => {
    const doc = buildDocumentModel(
      snapshot({}, { i1: version(`Soal $${source}$`) }),
      template,
    );
    const { warnings } = renderDocument(doc, "paper", { paper: "A4", font: "times" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].source).not.toMatch(LONE_SURROGATE);
    expect(warnings[0].source.endsWith("\u{1F600}...")).toBe(true);
  });
});

describe("source hygiene", () => {
  it("writes the XML character ranges as escapes, not raw invisible characters", () => {
    for (const file of ["xml.ts", "latex-to-omml.ts", "render-docx.ts"]) {
      const text = readFileSync(path.join(import.meta.dirname, file), "utf8");
      const raw = new RegExp(
        `[${[0xd7ff, 0xe000, 0xfffd].map((p) => String.fromCodePoint(p)).join("")}]`,
      );
      expect(text, file).not.toMatch(raw);
      expect(text, file).not.toMatch(/const NOT_XML\b/);
    }
  });
});
