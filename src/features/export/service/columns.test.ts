import { describe, expect, it } from "vitest";
import { optionColumns, renderedLength } from "./columns";

const four = (text: string) => [text, text, text, text];

describe("renderedLength", () => {
  it("counts visible characters, not LaTeX source", () => {
    expect(renderedLength("12")).toBe(2);
    expect(renderedLength("$\\frac{1}{2}$")).toBe(3);
    expect(renderedLength("$x^{2}+3x$")).toBe(5);
    expect(renderedLength("$\\left(x+1\\right)$")).toBe(5);
    expect(renderedLength("$\\text{cm}$")).toBe(2);
    expect(renderedLength("a $\\pi$ b")).toBe(5);
  });
  it("does not count Markdown emphasis markers", () => {
    expect(renderedLength("**tebal**")).toBe(5);
    expect(renderedLength("*miring*")).toBe(6);
    expect(renderedLength("a * b")).toBe(5);
  });
  it("treats a line break as very long", () => {
    expect(renderedLength("a\nb")).toBeGreaterThan(100);
  });
});

describe("optionColumns thresholds", () => {
  // 4 columns: four options, longest <= 10; 2 columns: longest <= 34; otherwise 1.
  const table: [string, string[], 1 | 2 | 4][] = [
    ["four short numbers", ["12", "15", "18", "21"], 4],
    ["exactly 10 chars", four("1234567890"), 4],
    ["11 chars -> 2", four("12345678901"), 2],
    ["34 chars -> 2", four("x".repeat(34)), 2],
    ["35 chars -> 1", four("x".repeat(35)), 1],
    ["one long option forces 1", ["1", "2", "3", "y".repeat(60)], 1],
    ["three short options -> 2 (not 4)", ["1", "2", "3"], 2],
    ["two short options -> 2", ["Benar", "Salah"], 2],
    [
      "math is measured rendered",
      ["$\\frac{1}{2}$", "$\\frac{3}{4}$", "$\\sqrt{2}$", "$\\pi$"],
      4,
    ],
    ["multi-line option -> 1", ["a\nb", "c", "d", "e"], 1],
    ["no options -> 1", [], 1],
    ["one option -> 1", ["a"], 1],
  ];
  it.each(table)("%s", (_name, options, expected) => {
    expect(optionColumns(options)).toBe(expected);
  });
});
