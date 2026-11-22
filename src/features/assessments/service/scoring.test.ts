import { describe, expect, it } from "vitest";
import {
  allocateEqual,
  MAX_POINTS,
  normalise,
  parsePoints,
  scorePoints,
  toHundredths,
} from "./scoring";

// A small seeded PRNG for the generated cases (mulberry32), so a failure is reproducible.
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exactly two decimals: the value is a whole number of hundredths. */
const hasTwoDecimals = (value: number) =>
  Math.abs(value * 100 - Math.round(value * 100)) < 1e-9 &&
  Number(value.toFixed(2)) === value;

const sumHundredths = (values: number[]) =>
  values.reduce((sum, value) => sum + toHundredths(value), 0);

describe("allocateEqual", () => {
  it("gives nothing for no items", () => {
    expect(allocateEqual(0)).toEqual([]);
  });

  it("splits 100 with the largest remainder going to the first items", () => {
    expect(allocateEqual(1)).toEqual([100]);
    expect(allocateEqual(3)).toEqual([33.34, 33.33, 33.33]);
    expect(allocateEqual(6)).toEqual([16.67, 16.67, 16.67, 16.67, 16.66, 16.66]);
    expect(allocateEqual(7)).toEqual([14.29, 14.29, 14.29, 14.29, 14.28, 14.28, 14.28]);
  });

  it("sums to exactly 100 in two-decimal points for every n from 1 to 200", () => {
    for (let n = 1; n <= 200; n += 1) {
      const points = allocateEqual(n);
      expect(points, `n=${String(n)}`).toHaveLength(n);
      expect(sumHundredths(points), `n=${String(n)}`).toBe(10000);
      expect(points.every(hasTwoDecimals), `n=${String(n)}`).toBe(true);
      // Equal shares: no two points differ by more than one hundredth.
      const spread =
        toHundredths(Math.max(...points)) - toHundredths(Math.min(...points));
      expect(spread, `n=${String(n)}`).toBeLessThanOrEqual(1);
    }
  });

  it("refuses a negative or fractional count", () => {
    expect(() => allocateEqual(-1)).toThrow(RangeError);
    expect(() => allocateEqual(2.5)).toThrow(RangeError);
  });
});

describe("normalise", () => {
  it("scales positive points to 100 in proportion", () => {
    expect(normalise([1, 1, 2])).toEqual([25, 25, 50]);
    expect(normalise([10, 10, 10])).toEqual([33.34, 33.33, 33.33]);
    expect(normalise([3])).toEqual([100]);
    expect(normalise([0.01, 0.02])).toEqual([33.33, 66.67]);
  });

  it("gives an item with zero points zero", () => {
    expect(normalise([0, 5, 5])).toEqual([0, 50, 50]);
  });

  it("refuses a zero total, a negative or a non-finite point", () => {
    expect(() => normalise([])).toThrow(RangeError);
    expect(() => normalise([0, 0])).toThrow(RangeError);
    expect(() => normalise([5, -1])).toThrow(RangeError);
    expect(() => normalise([5, Number.NaN])).toThrow(RangeError);
    expect(() => normalise([Number.POSITIVE_INFINITY])).toThrow(RangeError);
    // Finite inputs whose total overflows would otherwise give NaN shares.
    expect(() => normalise([Number.MAX_VALUE, Number.MAX_VALUE])).toThrow(RangeError);
    expect(() => normalise([1e300, 1])).toThrow(RangeError);
  });

  it("sums to exactly 100 in two-decimal points for 2000 random arrays", () => {
    const random = prng(20261119);
    for (let run = 0; run < 2000; run += 1) {
      const length = 1 + Math.floor(random() * 200);
      const points = Array.from({ length }, () => {
        // Hundredths from 0.01 to MAX_POINTS, some tiny, some large.
        const scale = random() < 0.2 ? 1 : MAX_POINTS * 100;
        return Math.max(1, Math.floor(random() * scale)) / 100;
      });
      const result = normalise(points);
      expect(result, `run=${String(run)}`).toHaveLength(length);
      expect(sumHundredths(result), `run=${String(run)} ${JSON.stringify(points)}`).toBe(
        10000,
      );
      expect(result.every(hasTwoDecimals), `run=${String(run)}`).toBe(true);
      expect(result.every((value) => value >= 0)).toBe(true);
    }
  });

  it("keeps the order of the shares: a larger input never gets fewer points", () => {
    const random = prng(7);
    for (let run = 0; run < 500; run += 1) {
      const points = Array.from(
        { length: 2 + Math.floor(random() * 30) },
        () => (1 + Math.floor(random() * 2000)) / 100,
      );
      const result = normalise(points);
      for (let i = 0; i < points.length; i += 1) {
        for (let j = 0; j < points.length; j += 1) {
          if (points[i] > points[j]) {
            expect(result[i]).toBeGreaterThanOrEqual(result[j]);
          }
        }
      }
    }
  });
});

describe("scorePoints", () => {
  it("equal ignores the stored points", () => {
    expect(scorePoints("equal", [0, 7, 0])).toEqual([33.34, 33.33, 33.33]);
  });

  it("manual keeps the stored points, any total", () => {
    expect(scorePoints("manual", [2, 3.5, 10])).toEqual([2, 3.5, 10]);
  });

  it("normalised scales them, and is null when nothing has points", () => {
    expect(scorePoints("normalised", [1, 3])).toEqual([25, 75]);
    expect(scorePoints("normalised", [0, 0])).toBeNull();
    expect(scorePoints("normalised", [])).toEqual([]);
  });
});

describe("parsePoints", () => {
  it("accepts positive points in steps of 0.01 up to the maximum", () => {
    expect(parsePoints("5")).toBe(5);
    expect(parsePoints("2.5")).toBe(2.5);
    expect(parsePoints("0.01")).toBe(0.01);
    expect(parsePoints(" 12,75 ")).toBe(12.75);
    expect(parsePoints(3.25)).toBe(3.25);
    expect(parsePoints(String(MAX_POINTS))).toBe(MAX_POINTS);
  });

  it("refuses zero, negatives, more than two decimals, too large and non-numbers", () => {
    for (const value of [
      "0",
      0,
      "-1",
      "1.234",
      1.234,
      String(MAX_POINTS + 0.01),
      "abc",
      "",
      "1e2",
      Number.NaN,
      null,
      undefined,
      {},
    ]) {
      expect(
        parsePoints(value),
        value === undefined ? "undefined" : JSON.stringify(value),
      ).toBeNull();
    }
  });
});
