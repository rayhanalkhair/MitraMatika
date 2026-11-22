import { describe, expect, it } from "vitest";
import {
  clampJson,
  isValidEventName,
  MAX_JSON_BYTES,
  normalizeUuid,
  truncateMessage,
} from "./sanitize";

describe("isValidEventName", () => {
  it.each(["sign_in", "job:generate_batch", "question.approved", "a-b_c"])(
    "accepts %s",
    (value) => {
      expect(isValidEventName(value)).toBe(true);
    },
  );

  it.each(["", "ab", "Sign_in", "1abc", "has space", "x".repeat(65), "naïve", null, 5])(
    "rejects %j",
    (value) => {
      expect(isValidEventName(value)).toBe(false);
    },
  );
});

describe("clampJson", () => {
  it("keeps a small object as is", () => {
    expect(clampJson({ method: "google", n: 1 })).toEqual({ method: "google", n: 1 });
  });

  it("turns undefined and non-objects into an empty object", () => {
    expect(clampJson(undefined)).toEqual({});
    expect(clampJson("text")).toEqual({});
    expect(clampJson([1, 2])).toEqual({});
    expect(clampJson(null)).toEqual({});
  });

  it("returns an empty object when toJSON turns the value into a non-object", () => {
    expect(clampJson(new Date())).toEqual({});
    expect(clampJson({ toJSON: () => null })).toEqual({});
    expect(clampJson({ toJSON: () => 42 })).toEqual({});
  });

  it("replaces an oversize object with the truncation marker", () => {
    const big = { text: "x".repeat(MAX_JSON_BYTES) };
    expect(clampJson(big)).toEqual({ truncated: true });
  });

  it("counts bytes, not characters", () => {
    const multibyte = { text: "é".repeat(MAX_JSON_BYTES / 2) };
    expect(clampJson(multibyte)).toEqual({ truncated: true });
  });

  it("replaces an object that cannot be serialised with the marker", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(clampJson(cyclic)).toEqual({ truncated: true });
  });

  it("removes lone surrogates so the value is valid JSON for Postgres", () => {
    const result = clampJson({ text: `a\ud83db` });
    expect((result.text as string).isWellFormed()).toBe(true);
  });
});

describe("truncateMessage", () => {
  it("keeps short text", () => {
    expect(truncateMessage("hello")).toBe("hello");
  });

  it("truncates by code point to the limit", () => {
    expect(Array.from(truncateMessage("x".repeat(1000)))).toHaveLength(500);
  });

  it("never splits a surrogate pair at the boundary", () => {
    const text = `${"a".repeat(499)}😀${"b".repeat(50)}`;
    const result = truncateMessage(text);
    expect(result.isWellFormed()).toBe(true);
    expect(Array.from(result)).toHaveLength(500);
    expect(result.endsWith("😀")).toBe(true);
  });

  it("repairs a lone surrogate in the input", () => {
    expect(truncateMessage("a\ud83d").isWellFormed()).toBe(true);
  });
});

describe("normalizeUuid", () => {
  it("returns a valid uuid lowercased and anything else null", () => {
    expect(normalizeUuid("11111111-1111-4111-8111-111111111111")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(normalizeUuid("11111111-1111-4111-8111-11111111111G")).toBeNull();
    expect(normalizeUuid("nope")).toBeNull();
    expect(normalizeUuid(undefined)).toBeNull();
  });
});
