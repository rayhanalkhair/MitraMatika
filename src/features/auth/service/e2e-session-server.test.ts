import { afterEach, describe, expect, it, vi } from "vitest";

const { cookiesMock, deleteMock } = vi.hoisted(() => {
  const deleteMock = vi.fn();
  return {
    deleteMock,
    cookiesMock: vi.fn(() => Promise.resolve({ delete: deleteMock })),
  };
});

vi.mock("next/headers", () => ({ cookies: cookiesMock }));

import { clearFakeSession } from "./e2e-session-server";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  deleteMock.mockReset();
});

describe("clearFakeSession", () => {
  it("deletes the e2e-user cookie when the fake session is enabled", async () => {
    vi.stubEnv("E2E_FAKE_AUTH", "1");
    vi.stubEnv("NODE_ENV", "development");
    await clearFakeSession();
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledWith("e2e-user");
  });

  it("does nothing when the flag is unset", async () => {
    vi.stubEnv("E2E_FAKE_AUTH", "");
    vi.stubEnv("NODE_ENV", "development");
    await clearFakeSession();
    expect(cookiesMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("does nothing in production even when the flag is set", async () => {
    vi.stubEnv("E2E_FAKE_AUTH", "1");
    vi.stubEnv("NODE_ENV", "production");
    await clearFakeSession();
    expect(cookiesMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("never throws, so the redirect that follows always happens", async () => {
    vi.stubEnv("E2E_FAKE_AUTH", "1");
    vi.stubEnv("NODE_ENV", "development");
    deleteMock.mockImplementation(() => {
      throw new Error("cookies cannot be modified here");
    });
    await expect(clearFakeSession()).resolves.toBeUndefined();
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });
});
