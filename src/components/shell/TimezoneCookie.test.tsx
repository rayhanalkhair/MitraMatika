// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { TimezoneCookie } from "./TimezoneCookie";

let written: string[];

beforeEach(() => {
  written = [];
  vi.spyOn(document, "cookie", "get").mockImplementation(() => "");
  vi.spyOn(document, "cookie", "set").mockImplementation((value: string) => {
    written.push(value);
  });
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    timeZone: "America/New_York",
  } as Intl.ResolvedDateTimeFormatOptions);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TimezoneCookie", () => {
  it("renders nothing", () => {
    const { container } = render(<TimezoneCookie />);
    expect(container.innerHTML).toBe("");
  });

  it("writes the tz cookie once when it is absent", () => {
    render(<TimezoneCookie />);
    expect(written).toHaveLength(1);
    expect(written[0]).toBe(
      `tz=${encodeURIComponent("America/New_York")}; path=/; max-age=31536000; samesite=lax`,
    );
  });

  it("does nothing when the cookie already matches", () => {
    vi.spyOn(document, "cookie", "get").mockImplementation(
      () => `a=b; tz=${encodeURIComponent("America/New_York")}`,
    );
    render(<TimezoneCookie />);
    expect(written).toEqual([]);
  });

  it("rewrites when the cookie differs", () => {
    vi.spyOn(document, "cookie", "get").mockImplementation(() => "tz=UTC");
    render(<TimezoneCookie />);
    expect(written).toHaveLength(1);
  });

  it("adds secure on https", () => {
    vi.stubGlobal("location", { protocol: "https:" });
    render(<TimezoneCookie />);
    vi.unstubAllGlobals();
    expect(written[0]).toMatch(/; secure$/);
  });
});
