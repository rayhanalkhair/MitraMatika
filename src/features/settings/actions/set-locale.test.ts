import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { setMock, revalidatePathMock } = vi.hoisted(() => ({
  setMock: vi.fn(),
  revalidatePathMock: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ set: setMock, get: vi.fn() }),
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

import { setLocaleAction } from "./set-locale";

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("setLocaleAction", () => {
  it.each(["id", "en"] as const)("writes the %s locale cookie", async (locale) => {
    await expect(setLocaleAction(locale)).resolves.toEqual({ ok: true });
    expect(setMock).toHaveBeenCalledTimes(1);
    const [name, value, options] = setMock.mock.calls[0] as [
      string,
      string,
      { path: string; sameSite: string; httpOnly: boolean; maxAge: number },
    ];
    expect(name).toBe("NEXT_LOCALE");
    expect(value).toBe(locale);
    expect(options.path).toBe("/");
    expect(options.sameSite).toBe("lax");
    expect(options.httpOnly).toBe(false);
    expect(options.maxAge).toBeGreaterThanOrEqual(60 * 60 * 24 * 180);
  });

  it.each([
    ["production", true],
    ["test", false],
    ["development", false],
  ])("sets secure for NODE_ENV=%s: %s", async (env, secure) => {
    vi.stubEnv("NODE_ENV", env);
    await setLocaleAction("en");
    const options = setMock.mock.calls[0]?.[2] as { secure: boolean };
    expect(options.secure).toBe(secure);
  });

  it("refreshes every page that renders translated text", async () => {
    await setLocaleAction("en");
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
  });

  it.each(["fr", "", "ID", "en ", "__proto__", 7, null, undefined])(
    "rejects %j and writes nothing",
    async (value) => {
      await expect(setLocaleAction(value)).resolves.toEqual({ ok: false });
      expect(setMock).not.toHaveBeenCalled();
      expect(revalidatePathMock).not.toHaveBeenCalled();
    },
  );
});
