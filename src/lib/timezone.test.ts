import { beforeEach, describe, expect, it, vi } from "vitest";

const cookieValue = vi.hoisted(() => ({ current: undefined as string | undefined }));
const failing = vi.hoisted(() => ({ on: false }));

vi.mock("next/headers", () => ({
  cookies: () => {
    if (failing.on) return Promise.reject(new Error("outside a request scope"));
    return Promise.resolve({
      get: (name: string) =>
        name === "tz" && cookieValue.current !== undefined
          ? { name, value: cookieValue.current }
          : undefined,
    });
  },
}));

import {
  DEFAULT_TIMEZONE,
  getViewerTimezone,
  isValidTimeZone,
  TZ_COOKIE,
} from "./timezone";

beforeEach(() => {
  cookieValue.current = undefined;
  failing.on = false;
});

describe("isValidTimeZone", () => {
  it("accepts IANA zones", () => {
    for (const zone of [
      "Asia/Jakarta",
      "UTC",
      "America/New_York",
      "Asia/Makassar",
      "Etc/UTC",
      "asia/jakarta", // Intl matches zone names case-insensitively
    ]) {
      expect(isValidTimeZone(zone)).toBe(true);
    }
  });

  it("rejects everything that is not an IANA zone", () => {
    const values: unknown[] = [
      "Mars/Olympus",
      "",
      "../../etc/passwd",
      "/Asia/Jakarta",
      "a/".repeat(150),
      "x".repeat(300),
      "+07:00",
      "UTC ", // trailing whitespace is not part of a zone name
      undefined,
      null,
      42,
      {},
    ];
    for (const value of values) expect(isValidTimeZone(value)).toBe(false);
  });
});

describe("getViewerTimezone", () => {
  it("names the cookie tz and defaults to Asia/Jakarta", () => {
    expect(TZ_COOKIE).toBe("tz");
    expect(DEFAULT_TIMEZONE).toBe("Asia/Jakarta");
  });

  it("falls back to Asia/Jakarta without a cookie", async () => {
    await expect(getViewerTimezone()).resolves.toBe("Asia/Jakarta");
  });

  it("returns a valid cookie value", async () => {
    cookieValue.current = "UTC";
    await expect(getViewerTimezone()).resolves.toBe("UTC");
  });

  it("falls back for invalid cookie values", async () => {
    for (const value of ["Mars/Olympus", "", "../../etc/passwd", "z".repeat(300)]) {
      cookieValue.current = value;
      await expect(getViewerTimezone()).resolves.toBe("Asia/Jakarta");
    }
  });

  it("never throws outside a request scope", async () => {
    failing.on = true;
    await expect(getViewerTimezone()).resolves.toBe("Asia/Jakarta");
  });
});
