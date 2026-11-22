import { SaxesParser } from "saxes";
import { describe, expect, it } from "vitest";
import { latexToOmml, LatexToOmmlError } from "./latex-to-omml";

/** Element names in document order; throws when the XML is not well-formed. */
function elements(xml: string): string[] {
  const names: string[] = [];
  const parser = new SaxesParser({ xmlns: false });
  parser.on("error", (error) => {
    throw error;
  });
  parser.on("opentag", (tag) => names.push(tag.name));
  parser.write(xml).close();
  return names;
}

/** The text of every m:t, joined. */
function mathText(xml: string): string {
  return [...xml.matchAll(/<m:t(?: [^>]*)?>([^<]*)<\/m:t>/g)].map((m) => m[1]).join("");
}

describe("latexToOmml", () => {
  it.each([
    ["\\frac{a}{b}", "m:f"],
    ["\\sqrt{x}", "m:rad"],
    ["\\sqrt[3]{8}", "m:rad"],
    ["x^2", "m:sSup"],
    ["a_1", "m:sSub"],
  ])("%s gives an m:oMath with %s", (latex, element) => {
    const omml = latexToOmml(latex);
    const names = elements(omml);
    expect(names[0]).toBe("m:oMath");
    expect(names).toContain(element);
  });

  it("keeps the parts of a fraction in m:num and m:den", () => {
    const omml = latexToOmml("\\frac{a}{b}");
    expect(omml).toMatch(/<m:num>.*>a<\/m:t>.*<\/m:num>/);
    expect(omml).toMatch(/<m:den>.*>b<\/m:t>.*<\/m:den>/);
  });

  it.each([
    ["\\le", "≤"],
    ["\\times", "×"],
    ["\\ge", "≥"],
    ["\\in", "∈"],
  ])("%s becomes the symbol %s in m:t", (latex, symbol) => {
    const omml = latexToOmml(latex);
    expect(elements(omml)[0]).toBe("m:oMath");
    expect(mathText(omml)).toBe(symbol);
  });

  it("carries no LaTeX annotation and no MathML namespace", () => {
    const omml = latexToOmml("\\frac{1}{2}");
    expect(omml).not.toContain("annotation");
    expect(omml).not.toContain("MathML");
    expect(omml).not.toContain("x-tex");
  });

  it("writes a decimal comma as one number", () => {
    expect(mathText(latexToOmml("9{,}60"))).toBe("9,60");
  });

  it("escapes markup characters and stays well-formed", () => {
    const omml = latexToOmml("a < b \\text{ \\& <script>}");
    expect(() => elements(omml)).not.toThrow();
    expect(omml).not.toContain("<script>");
    expect(omml).toContain("&lt;");
  });

  it("handles matrices and nested fractions", () => {
    const matrix = latexToOmml("\\begin{bmatrix}1&2\\\\3&4\\end{bmatrix}");
    expect(elements(matrix)).toContain("m:m");
    const nested = latexToOmml("\\frac{\\frac{1}{2}}{\\frac{3}{4}}");
    expect(elements(nested).filter((n) => n === "m:f")).toHaveLength(3);
  });

  it("throws a typed parse error on an unknown command", () => {
    expect(() => latexToOmml("\\foo{x}")).toThrow(LatexToOmmlError);
    try {
      latexToOmml(String.raw`\foo{x}`);
      expect.unreachable();
    } catch (error) {
      expect((error as LatexToOmmlError).code).toBe("parse");
    }
  });

  it("throws a typed error on MathML the converter does not know", () => {
    // \phantom gives <mphantom>, which mathml2omml does not handle.
    try {
      latexToOmml("a\\phantom{b}c");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LatexToOmmlError);
      expect((error as LatexToOmmlError).code).toBe("unsupported");
    }
  });

  it("refuses trust-only commands and unicode text in math (strict)", () => {
    // KaTeX does not throw on these with trust off; it prints the command name in red.
    for (const latex of [
      "\\href{https://example.com}{x}",
      "\\includegraphics{x.png}",
      "\\url{https://x.y}",
    ]) {
      try {
        latexToOmml(latex);
        expect.unreachable(latex);
      } catch (error) {
        expect((error as LatexToOmmlError).code, latex).toBe("unsupported");
      }
    }
    expect(() => latexToOmml("é")).toThrow(LatexToOmmlError);
  });

  it("refuses expansion bombs", () => {
    const ten = (name: string) => `\\${name}`.repeat(10);
    const bomb = `\\def\\a{x}\\def\\b{${ten("a")}}\\def\\c{${ten("b")}}\\def\\d{${ten("c")}}\\d`;
    expect(() => latexToOmml(bomb)).toThrow(LatexToOmmlError);
  });

  it("refuses control characters and empty input", () => {
    expect(() => latexToOmml("a\u0000b")).toThrow(LatexToOmmlError);
    expect(() => latexToOmml("a\u0008b")).toThrow(LatexToOmmlError);
    expect(() => latexToOmml("   ")).toThrow(LatexToOmmlError);
  });

  it("keeps the source out of the error message", () => {
    try {
      latexToOmml(String.raw`\secretcommand`);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LatexToOmmlError);
      expect((error as Error).message).not.toContain("secretcommand");
    }
  });
});
