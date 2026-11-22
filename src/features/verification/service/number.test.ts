import { describe, expect, it } from "vitest";
import { numbersEquivalent, parseNumber } from "./number";

describe("parseNumber", () => {
  it.each([
    ["2,5", 2.5],
    ["0,5", 0.5],
    ["1.000", 1000],
    ["12.345.678", 12345678],
    ["1.000,5", 1000.5],
    ["2.5", 2.5],
    ["-7", -7],
    ["1/2", 0.5],
    ["-3/4", -0.75],
    ["50%", 0.5],
    [" 2 , 5 ", 2.5],
    ["0.125", 0.125],
    ["0.500", 0.5],
    ["0.001", 0.001],
    ["0,125", 0.125],
    ["1.5625e19", 1.5625e19],
    ["7.2e1", 72],
    ["-3.5e-2", -0.035],
    ["1E10", 1e10],
    ["2.5e0", 2.5],
  ])("parses %s as %d", (raw, expected) => {
    expect(parseNumber(raw)).toBeCloseTo(expected, 12);
  });

  it.each([
    ["abc"],
    [""],
    ["1/0"],
    ["1,2,3"],
    ["--4"],
    ["1.2,5"],
    ["1,5.5"],
    ["1.0,5"],
    ["1.000.5"],
  ])("returns null for %s", (raw) => {
    expect(parseNumber(raw)).toBeNull();
  });
});

describe("numbersEquivalent", () => {
  it("treats 0,5 = 1/2 = 50% as equivalent", () => {
    expect(numbersEquivalent("0,5", "1/2")).toBe(true);
    expect(numbersEquivalent("1/2", "50%")).toBe(true);
    expect(numbersEquivalent("0.5", "0,5")).toBe(true);
  });

  it("distinguishes different values", () => {
    expect(numbersEquivalent("0,5", "0,51")).toBe(false);
  });

  it("is false when either side is not a number", () => {
    expect(numbersEquivalent("x", "1")).toBe(false);
  });
});

describe("parseNumber comma forms with leading zero", () => {
  it("rejects a leading-zero dotted group before a comma", () => {
    expect(parseNumber("0.123,5")).toBeNull();
  });

  it("keeps valid comma forms", () => {
    expect(parseNumber("1.000,5")).toBe(1000.5);
    expect(parseNumber("0,125")).toBe(0.125);
    expect(parseNumber("2,5")).toBe(2.5);
  });
});
