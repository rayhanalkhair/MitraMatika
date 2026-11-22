import { describe, expect, it } from "vitest";
import { withDecimalComma } from "./decimal-comma";

const DECIMAL: [string, string][] = [
  ["9,60", "9{,}60"],
  ["0,5", "0{,}5"],
  ["1.234,56", "1.234{,}56"],
  ["3,14\\,\\text{cm}", "3{,}14\\,\\text{cm}"],
  ["\\frac{3,5}{2}", "\\frac{3{,}5}{2}"],
  ["\\sqrt{2,25}", "\\sqrt{2{,}25}"],
  ["10^{1,5}", "10^{1{,}5}"],
  ["x = 2,5 + 1,25", "x = 2{,}5 + 1{,}25"],
  // inside parentheses and brackets, when the group is clearly arithmetic
  ["3\\times(1,5+2)", "3\\times(1{,}5+2)"],
  ["(12,5)\\%", "(12{,}5)\\%"],
  ["(12,5)\\times 2", "(12{,}5)\\times 2"],
  ["[2,5+1]", "[2{,}5+1]"],
  ["(9,60+1)", "(9{,}60+1)"],
  ["(0,5+1)", "(0{,}5+1)"],
  ["(1,5 \\text{ cm})", "(1{,}5 \\text{ cm})"],
  ["\\left(1,5+2\\right)", "\\left(1{,}5+2\\right)"],
  ["\\left(1,5+2\\right.", "\\left(1{,}5+2\\right."],
  ["\\lfloor 3,7\\rfloor", "\\lfloor 3{,}7\\rfloor"],
  ["\\lceil 3,2\\rceil", "\\lceil 3{,}2\\rceil"],
  // a group nested in a list keeps its own decimal context
  ["(x,\\frac{1,5}{2})", "(x,\\frac{1{,}5}{2})"],
  // text bodies are copied through, so a `)` in them cannot pop the outer group
  ["\\text{a)}3,5", "\\text{a)}3{,}5"],
  ["(\\text{)}1,5+2)", "(\\text{)}1{,}5+2)"],
  ["\\mathrm{m)}2,5", "\\mathrm{m)}2{,}5"],
];

const UNCHANGED = [
  "A(2, 3)",
  "A(2,3)",
  "f(2,3)",
  "(x,y)=(3,4)",
  "(3,4)",
  "(0,5)", // a bare pair is ambiguous: left as written
  "[1,5]",
  "(1,2)",
  "[1,2]",
  "\\left(1,2\\right)",
  "\\{1,2,3\\}",
  "\\{1,2\\}",
  "\\lbrace 1,2\\rbrace",
  "\\langle 1,2\\rangle",
  "2,4,6,8",
  "1,2,3",
  "1,234,567",
  "a_{1,2}",
  "P_{2,3}",
  "\\binom{5,2}{3}",
  "\\begin{pmatrix}1,5 & 2\\end{pmatrix}",
  "a,b",
  "x, 5",
  "9.60",
  "9{,}60",
];

describe("withDecimalComma", () => {
  it.each(DECIMAL)("turns %s into KaTeX's decimal form", (input, expected) => {
    expect(withDecimalComma(input)).toBe(expected);
  });

  it.each(UNCHANGED)("leaves %s unchanged", (input) => {
    expect(withDecimalComma(input)).toBe(input);
  });

  it("is idempotent", () => {
    for (const [input] of DECIMAL) {
      const once = withDecimalComma(input);
      expect(withDecimalComma(once)).toBe(once);
    }
  });

  it("stays cheap on a very long input", () => {
    const flat = "1,5+".repeat(100_000);
    const nested = "(1,5+".repeat(2_000) + ")".repeat(2_000);
    const start = performance.now();
    withDecimalComma(flat);
    withDecimalComma(nested);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
