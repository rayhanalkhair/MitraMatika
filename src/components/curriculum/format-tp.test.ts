import { describe, expect, it } from "vitest";
import { formatTP } from "./format-tp";

describe("formatTP", () => {
  it.each([
    ["TP TP-08-GEO-01", "TP-08-GEO-01"],
    ["TP-08-GEO-01", "TP-08-GEO-01"],
    ["tp tp-08-geo-01", "TP-08-geo-01"],
    ["  TP   TP-08-GEO-01  ", "TP-08-GEO-01"],
    ["7.1", "TP-7.1"],
    ["TP 7.1", "TP-7.1"],
  ])("strips repeated TP prefixes: %j -> %j", (input, expected) => {
    expect(formatTP(input)).toBe(expected);
  });
});
