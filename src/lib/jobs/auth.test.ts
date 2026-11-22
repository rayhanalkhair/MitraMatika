import { afterEach, describe, expect, it, vi } from "vitest";
import { isRunnerAuthorized, readCronSecret } from "./auth";

const SECRET = "s".repeat(40);

describe("isRunnerAuthorized", () => {
  it("accepts the exact bearer secret", () => {
    expect(isRunnerAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it.each([
    ["no header", null],
    ["empty header", ""],
    ["wrong secret", `Bearer ${"t".repeat(40)}`],
    ["a prefix of the secret", `Bearer ${SECRET.slice(0, 39)}`],
    ["the secret with extra characters", `Bearer ${SECRET}x`],
    ["a different scheme", `Basic ${SECRET}`],
    ["no scheme", SECRET],
    ["lowercase scheme", `bearer ${SECRET}`],
  ])("rejects %s", (_name, header) => {
    expect(isRunnerAuthorized(header, SECRET)).toBe(false);
  });

  it("the Bearer comparison is length-independent", () => {
    // timingSafeEqual throws on buffers of different lengths; comparing fixed-length digests means
    // a token of any length is simply rejected, and its length never changes the code path.
    for (const token of ["x", SECRET.slice(0, 39), `${SECRET}x`, "y".repeat(4096)]) {
      expect(() => isRunnerAuthorized(`Bearer ${token}`, SECRET)).not.toThrow();
      expect(isRunnerAuthorized(`Bearer ${token}`, SECRET)).toBe(false);
    }
  });

  it("rejects everything when the secret is unset, empty or shorter than 32 characters", () => {
    expect(isRunnerAuthorized(`Bearer ${SECRET}`, undefined)).toBe(false);
    expect(isRunnerAuthorized("Bearer ", "")).toBe(false);
    const short = "a".repeat(31);
    expect(isRunnerAuthorized(`Bearer ${short}`, short)).toBe(false);
  });
});

describe("readCronSecret", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the configured secret", () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    expect(readCronSecret()).toBe(SECRET);
  });

  it("returns undefined, without throwing, when unset", () => {
    vi.stubEnv("CRON_SECRET", "");
    expect(readCronSecret()).toBeUndefined();
  });
});
