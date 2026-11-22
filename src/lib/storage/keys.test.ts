import { describe, expect, it } from "vitest";
import {
  assertSafeKey,
  assertSafePrefix,
  clampSeconds,
  MAX_SIGNED_SECONDS,
} from "./types";

describe("assertSafeKey", () => {
  it("accepts ids, slashes, dots, dashes and underscores", () => {
    expect(() => {
      assertSafeKey("exports/0190a-b_c/doc.v1.pdf");
    }).not.toThrow();
  });

  it.each([
    "",
    "/leading",
    "a/../b",
    "..",
    "a//b",
    "a b",
    "guru@example.com/x",
    "nama guru/x",
    "a/b/",
    "a\\b",
    "é/x",
  ])("rejects %j", (key) => {
    expect(() => {
      assertSafeKey(key);
    }).toThrow();
  });

  it("rejects a key over 512 characters", () => {
    expect(() => {
      assertSafeKey("a".repeat(513));
    }).toThrow();
  });
});

describe("assertSafePrefix", () => {
  it("requires a trailing slash and a safe body", () => {
    expect(() => {
      assertSafePrefix("exports/u1/");
    }).not.toThrow();
    expect(() => {
      assertSafePrefix("exports/u1");
    }).toThrow();
    expect(() => {
      assertSafePrefix("../");
    }).toThrow();
    expect(() => {
      assertSafePrefix("/");
    }).toThrow();
  });
});

describe("clampSeconds", () => {
  it("caps at the maximum and rejects non-positive values", () => {
    expect(MAX_SIGNED_SECONDS).toBe(300);
    expect(clampSeconds(9999)).toBe(300);
    expect(clampSeconds(30)).toBe(30);
    expect(() => clampSeconds(0)).toThrow();
    expect(() => clampSeconds(Number.NaN)).toThrow();
  });
});
