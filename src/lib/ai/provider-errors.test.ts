import { describe, expect, it } from "vitest";
import {
  classifyHttpFailure,
  makeDetail,
  parseRetryAfter,
  providerFailureMessage,
  redactSecrets,
  toProviderError,
  RETRY_AFTER_MAX_MS,
  RETRY_AFTER_MIN_MS,
} from "./provider-errors";

const NOW = Date.parse("2026-10-11T10:00:00.000Z");

describe("parseRetryAfter", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfter("30", NOW)).toBe(30_000);
    expect(parseRetryAfter(" 7 ", NOW)).toBe(7_000);
  });

  it("parses an HTTP date relative to now", () => {
    expect(parseRetryAfter("Sun, 11 Oct 2026 10:02:00 GMT", NOW)).toBe(120_000);
  });

  it("clamps to the allowed range", () => {
    expect(parseRetryAfter("0.2", NOW)).toBe(RETRY_AFTER_MIN_MS);
    expect(parseRetryAfter("999999999", NOW)).toBe(RETRY_AFTER_MAX_MS);
    expect(parseRetryAfter("Sun, 11 Oct 2026 18:00:00 GMT", NOW)).toBe(
      RETRY_AFTER_MAX_MS,
    );
  });

  it("rejects hostile or meaningless values", () => {
    for (const value of [
      "",
      "abc",
      "-5",
      "NaN",
      "Infinity",
      "0",
      "Sun, 11 Oct 2026 09:00:00 GMT",
    ]) {
      expect(parseRetryAfter(value, NOW)).toBeUndefined();
    }
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
  });

  it("treats a digit string that overflows to Infinity as the maximum", () => {
    expect(parseRetryAfter("9".repeat(400), NOW)).toBe(RETRY_AFTER_MAX_MS);
  });
});

describe("secrets and detail bounds", () => {
  it("redacts a key in a fetch rejection message", () => {
    const error = toProviderError(
      new TypeError("Failed to parse URL from https://x/y?key=AIzaSECRET&alt=json"),
    );
    expect(error.detail).not.toContain("AIzaSECRET");
    expect(error.detail).toContain("alt=json");
    expect(error.detail!.length).toBeLessThanOrEqual(500);
  });

  it("redacts apikey/api_key params and bearer tokens", () => {
    expect(redactSecrets("Authorization: Bearer abc123")).not.toContain("abc123");
    expect(redactSecrets("?apikey=zzz1&api_key=zzz2")).not.toMatch(/zzz/);
    expect(redactSecrets("?KEY=zzz3 rest")).not.toContain("zzz3");
  });

  it("bounds a hostile 5000-character message to 500 characters", () => {
    expect(toProviderError(new Error("x".repeat(5_000))).detail!.length).toBe(500);
    expect(makeDetail("y".repeat(5_000)).length).toBe(500);
  });
});

describe("classifyHttpFailure", () => {
  it("classifies 429 as rate limited and carries retry-after", () => {
    expect(classifyHttpFailure(429, "45", NOW)).toEqual({
      kind: "rate_limited",
      retryAfterMs: 45_000,
    });
    expect(classifyHttpFailure(429, null, NOW)).toEqual({ kind: "rate_limited" });
  });

  it("classifies 408 as a timeout", () => {
    expect(classifyHttpFailure(408, null, NOW).kind).toBe("timeout");
  });

  it("classifies 401 and 403 as a failed authentication", () => {
    for (const status of [401, 403]) {
      expect(classifyHttpFailure(status, "30", NOW)).toEqual({ kind: "auth_failed" });
    }
  });

  it("classifies 5xx and other 4xx as unavailable", () => {
    for (const status of [500, 502, 503, 504, 400, 404]) {
      expect(classifyHttpFailure(status, "30", NOW).kind).toBe("unavailable");
    }
  });
});

describe("providerFailureMessage", () => {
  it("is a fixed Indonesian sentence per kind and never empty", () => {
    for (const kind of [
      "rate_limited",
      "unavailable",
      "auth_failed",
      "timeout",
      "invalid_response",
    ] as const) {
      expect(providerFailureMessage(kind).length).toBeGreaterThan(10);
    }
  });
});
