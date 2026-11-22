import katex from "katex";
import { describe, expect, it } from "vitest";
import { latexToOmml } from "@/features/export";
import { EQUATIONS, M_NS, mr } from "../fixtures/ingest";
import { ommlToLatex } from "./omml-to-latex";

const math = (inner: string) => `<m:oMath xmlns:m="${M_NS}">${inner}</m:oMath>`;
const prop = (name: string, value: string) => `<m:${name} m:val="${value}"/>`;

describe("ommlToLatex", () => {
  it("converts fractions (bar, skewed, linear, no bar)", () => {
    expect(ommlToLatex(EQUATIONS.fraction)).toBe("\\frac{a}{b}");
    const typed = (type: string) =>
      math(
        `<m:f><m:fPr>${prop("type", type)}</m:fPr><m:num>${mr("x+1")}</m:num><m:den>${mr("2")}</m:den></m:f>`,
      );
    expect(ommlToLatex(typed("skw"))).toBe("\\frac{x+1}{2}");
    expect(ommlToLatex(typed("lin"))).toBe("{x+1}/2");
    expect(ommlToLatex(typed("noBar"))).toBe("\\genfrac{}{}{0pt}{}{x+1}{2}");
  });

  it("converts square roots and roots with a degree", () => {
    expect(ommlToLatex(EQUATIONS.root)).toBe("\\sqrt{x}");
    expect(
      ommlToLatex(math(`<m:rad><m:deg>${mr("3")}</m:deg><m:e>${mr("27")}</m:e></m:rad>`)),
    ).toBe("\\sqrt[3]{27}");
    // An empty degree is a square root even without degHide.
    expect(ommlToLatex(math(`<m:rad><m:deg/><m:e>${mr("y")}</m:e></m:rad>`))).toBe(
      "\\sqrt{y}",
    );
  });

  it("converts sub- and superscripts, pre-scripts included", () => {
    expect(ommlToLatex(EQUATIONS.power)).toBe("x^{2}+1");
    expect(
      ommlToLatex(
        math(`<m:sSub><m:e>${mr("a")}</m:e><m:sub>${mr("n")}</m:sub></m:sSub>`),
      ),
    ).toBe("a_{n}");
    expect(
      ommlToLatex(
        math(
          `<m:sSubSup><m:e>${mr("U")}</m:e><m:sub>${mr("n")}</m:sub><m:sup>${mr("2")}</m:sup></m:sSubSup>`,
        ),
      ),
    ).toBe("U_{n}^{2}");
    expect(
      ommlToLatex(
        math(
          `<m:sPre><m:sub>${mr("6")}</m:sub><m:sup>${mr("12")}</m:sup><m:e>${mr("C")}</m:e></m:sPre>`,
        ),
      ),
    ).toBe("{}_{6}^{12}C");
    // A base longer than one symbol is grouped.
    expect(
      ommlToLatex(
        math(`<m:sSup><m:e>${mr("ab")}</m:e><m:sup>${mr("n")}</m:sup></m:sSup>`),
      ),
    ).toBe("{ab}^{n}");
  });

  it("converts delimiters with their characters and separators", () => {
    expect(ommlToLatex(math(`<m:d><m:e>${mr("a+b")}</m:e></m:d>`))).toBe(
      "\\left(a+b\\right)",
    );
    // A bracketed base takes its script without extra braces.
    expect(ommlToLatex(EQUATIONS.brackets)).toBe("\\left(a+b\\right)^{2}");
    const delimited = (props: string, ...items: string[]) =>
      math(
        `<m:d><m:dPr>${props}</m:dPr>${items.map((item) => `<m:e>${mr(item)}</m:e>`).join("")}</m:d>`,
      );
    expect(
      ommlToLatex(delimited(prop("begChr", "[") + prop("endChr", "]"), "0", "1")),
    ).toBe("\\left[0|1\\right]");
    expect(
      ommlToLatex(
        delimited(
          prop("begChr", "{") + prop("endChr", "}") + prop("sepChr", ","),
          "1",
          "2",
        ),
      ),
    ).toBe("\\left\\{1,2\\right\\}");
    expect(ommlToLatex(delimited(prop("begChr", "|") + prop("endChr", "|"), "x"))).toBe(
      "\\left|x\\right|",
    );
    expect(ommlToLatex(delimited(prop("begChr", "") + prop("endChr", "|"), "x"))).toBe(
      "\\left.x\\right|",
    );
    expect(ommlToLatex(delimited(prop("begChr", "⟨") + prop("endChr", "⟩"), "u"))).toBe(
      "\\left\\langle u\\right\\rangle",
    );
    // An unknown delimiter character is not guessed.
    expect(ommlToLatex(delimited(prop("begChr", "⌘"), "x"))).toBeNull();
  });

  it("converts common operators, relations and Greek letters", () => {
    expect(ommlToLatex(math(mr("2×3÷4±1≤5≥0≠7−1·2")))).toBe(
      "2\\times 3\\div 4\\pm 1\\le 5\\ge 0\\neq 7-1\\cdot 2",
    );
    expect(ommlToLatex(math(mr("α+π≈3,14")))).toBe("\\alpha +\\pi \\approx 3,14");
    expect(ommlToLatex(math(mr("A∩B∪C, x∈ℝ, ∠ABC=90°")))).toBe(
      "A\\cap B\\cup C, x\\in \\mathbb{R}, \\angle ABC=90^{\\circ}",
    );
  });

  it("converts sums, products and integrals", () => {
    const nary = (props: string, sub: string, sup: string, body: string) =>
      math(
        `<m:nary><m:naryPr>${props}</m:naryPr><m:sub>${mr(sub)}</m:sub><m:sup>${mr(sup)}</m:sup><m:e>${mr(body)}</m:e></m:nary>`,
      );
    expect(ommlToLatex(nary(prop("chr", "∑"), "i=1", "n", "i"))).toBe(
      "\\sum_{i=1}^{n}{i}",
    );
    // No character means an integral.
    expect(ommlToLatex(nary("", "0", "1", "x"))).toBe("\\int_{0}^{1}{x}");
    expect(
      ommlToLatex(
        nary(
          prop("chr", "∏") + prop("subHide", "1") + prop("supHide", "on"),
          "",
          "",
          "k",
        ),
      ),
    ).toBe("\\prod{k}");
  });

  it("converts functions, bars, accents and normal text", () => {
    expect(
      ommlToLatex(
        math(`<m:func><m:fName>${mr("sin")}</m:fName><m:e>${mr("x")}</m:e></m:func>`),
      ),
    ).toBe("\\sin{x}");
    expect(
      ommlToLatex(
        math(`<m:func><m:fName>${mr("f")}</m:fName><m:e>${mr("x")}</m:e></m:func>`),
      ),
    ).toBe("\\operatorname{f}{x}");
    expect(
      ommlToLatex(
        math(
          `<m:bar><m:barPr>${prop("pos", "top")}</m:barPr><m:e>${mr("AB")}</m:e></m:bar>`,
        ),
      ),
    ).toBe("\\overline{AB}");
    // ECMA-376: without a position the bar is below.
    expect(ommlToLatex(math(`<m:bar><m:e>${mr("AB")}</m:e></m:bar>`))).toBe(
      "\\underline{AB}",
    );
    expect(
      ommlToLatex(
        math(
          `<m:acc><m:accPr>${prop("chr", "\u20d7")}</m:accPr><m:e>${mr("v")}</m:e></m:acc>`,
        ),
      ),
    ).toBe("\\vec{v}");
    expect(
      ommlToLatex(math(`<m:r><m:rPr><m:nor/></m:rPr><m:t>luas</m:t></m:r>${mr("=p×l")}`)),
    ).toBe("\\text{luas}=p\\times l");
  });

  it("ignores formatting properties (run, control and Word run properties)", () => {
    const formatted = math(
      `<m:f><m:fPr><m:ctrlPr><w:rPr xmlns:w="w"><w:i/></w:rPr></m:ctrlPr></m:fPr><m:num><m:r><w:rPr xmlns:w="w"><w:rFonts w:ascii="Cambria Math"/></w:rPr><m:t>1</m:t></m:r></m:num><m:den>${mr("2")}</m:den></m:f>`,
    );
    expect(ommlToLatex(formatted)).toBe("\\frac{1}{2}");
  });

  it("escapes LaTeX special characters in math text", () => {
    expect(ommlToLatex(math(mr("50% {a} #1 &amp; \\ $")))).toBe(
      "50\\% \\{a\\} \\#1 \\& \\backslash \\$",
    );
    // A caret typed in Word stays a caret (not an accent over nothing).
    expect(ommlToLatex(math(mr("2^3")))).toBe("2\\text{\\textasciicircum}3");
    expect(ommlToLatex(math(`<m:r><m:rPr><m:nor/></m:rPr><m:t>a^b~c</m:t></m:r>`))).toBe(
      "\\text{a\\textasciicircum{}b\\textasciitilde{}c}",
    );
    for (const latex of [
      "2\\text{\\textasciicircum}3",
      "\\text{a\\textasciicircum{}b}",
    ]) {
      expect(() => katex.renderToString(latex, { throwOnError: true })).not.toThrow();
    }
  });

  it("joins the equations of a display block", () => {
    const para = `<m:oMathPara xmlns:m="${M_NS}"><m:oMath>${mr("a=1")}</m:oMath><m:oMath>${mr("b=2")}</m:oMath></m:oMathPara>`;
    expect(ommlToLatex(para)).toBe("\\begin{gathered}a=1\\\\b=2\\end{gathered}");
    expect(ommlToLatex(`<m:oMathPara>${EQUATIONS.fraction}</m:oMathPara>`)).toBe(
      "\\frac{a}{b}",
    );
  });

  it("returns null for constructs it does not support, so the page is flagged", () => {
    expect(ommlToLatex(EQUATIONS.matrix)).toBeNull();
    expect(ommlToLatex(math(`<m:eqArr><m:e>${mr("a")}</m:e></m:eqArr>`))).toBeNull();
    expect(ommlToLatex(math(`<m:unknown>${mr("a")}</m:unknown>`))).toBeNull();
  });

  it("returns null for anything that is not one well-formed equation", () => {
    expect(ommlToLatex("<m:oMath><m:f>")).toBeNull();
    expect(ommlToLatex("<w:p/>")).toBeNull();
    expect(ommlToLatex("")).toBeNull();
    const deep = `${"<m:d><m:e>".repeat(80)}${mr("x")}${"</m:e></m:d>".repeat(80)}`;
    expect(ommlToLatex(math(deep))).toBeNull();
  });

  it("reads back what the export writes, as LaTeX KaTeX accepts", () => {
    const formulas: [string, string][] = [
      ["\\frac{3}{4}+\\frac{1}{4}=1", "\\frac{3}{4}+\\frac{1}{4}=1"],
      ["\\sqrt{16}=4", "\\sqrt{16}=4"],
      ["\\sqrt[3]{8}=2", "\\sqrt[3]{8}=2"],
      ["x^{2}-5x+6=0", "x^{2}-5x+6=0"],
      ["a_{n}=a_{1}+(n-1)b", "a_{n}=a_{1}+(n-1)b"],
      // The export writes the brackets as plain text inside the script's base.
      ["\\left(a+b\\right)^{2}", "{(a+b)}^{2}"],
      ["2\\times 3\\le 7", "2\\times 3\\le 7"],
      ["\\sum_{i=1}^{n} i", "\\sum_{i=1}^{n}{i}"],
    ];
    for (const [formula, expected] of formulas) {
      const latex = ommlToLatex(latexToOmml(formula));
      expect(latex, formula).toBe(expected);
      expect(() => katex.renderToString(expected, { throwOnError: true })).not.toThrow();
    }
  });
});
