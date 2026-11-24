import { describe, expect, it } from "vitest";
import { formatSize } from "./format-size";

// A minimal stand-in for next-intl's formatter: the Indonesian decimal comma.
const format = {
  number: (value: number, options?: { maximumFractionDigits?: number }) =>
    new Intl.NumberFormat("id-ID", options).format(value),
} as Parameters<typeof formatSize>[1];

describe("formatSize", () => {
  it.each([
    [0, "0 B"],
    [512, "512 B"],
    [999, "999 B"],
    [1000, "1 KB"],
    [1023, "1 KB"],
    [1024, "1 KB"],
    [3 * 1024, "3 KB"],
    [3_100, "3 KB"],
    [190 * 1024, "190 KB"],
    [1024 * 1024 - 1, "1 MB"],
    [1024 * 1024, "1 MB"],
    [Math.round(1.25 * 1024 * 1024), "1,3 MB"],
    [300 * 1024 * 1024, "300 MB"],
    [1024 ** 3, "1 GB"],
    [Math.round(1.5 * 1024 ** 3), "1,5 GB"],
  ])("writes %d bytes as %s", (bytes, expected) => {
    expect(formatSize(bytes, format)).toBe(expected);
  });

  it("never writes a small file as 0 MB", () => {
    expect(formatSize(3 * 1024, format)).not.toMatch(/^0/);
    expect(formatSize(200 * 1024, format)).not.toContain("MB");
  });
});
