import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeAuthPort } from "./fake-port";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
  cookies: vi.fn(),
  getAuthPort: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("./port-server", () => ({ getAuthPort: mocks.getAuthPort }));

import { authorizeAction, requireAllowedUser } from "./guard";

function signedInAs(user: { id: string; email: string } | null) {
  mocks.getAuthPort.mockResolvedValue(createFakeAuthPort({ getSessionUser: { user } }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookies.mockResolvedValue({ get: () => undefined });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("requireAllowedUser", () => {
  it("returns the allowed user", async () => {
    vi.stubEnv("ADMIN_EMAIL", "teacher@example.test");
    signedInAs({ id: "user-1", email: "teacher@example.test" });
    await expect(requireAllowedUser()).resolves.toMatchObject({
      status: "allowed",
      userId: "user-1",
      email: "teacher@example.test",
    });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("redirects an anonymous visitor to /sign-in", async () => {
    signedInAs(null);
    await expect(requireAllowedUser()).rejects.toThrow("NEXT_REDIRECT:/sign-in");
  });

  it("does not return a signed-in user whose email is not approved", async () => {
    vi.stubEnv("ADMIN_EMAIL", "teacher@example.test");
    signedInAs({ id: "user-2", email: "stranger@example.test" });
    await expect(requireAllowedUser()).rejects.toThrow("NEXT_REDIRECT:/sign-in");
  });

  it("redirects to /sign-in when Better Auth is not configured or unreachable", async () => {
    mocks.getAuthPort.mockRejectedValue(new Error("no env"));
    await expect(requireAllowedUser()).rejects.toThrow("NEXT_REDIRECT:/sign-in");
  });
});

describe("authorizeAction", () => {
  it("authorizes an allowed user", async () => {
    vi.stubEnv("ADMIN_EMAIL", "teacher@example.test");
    signedInAs({ id: "user-1", email: "teacher@example.test" });
    const result = await authorizeAction();
    expect(result).toMatchObject({ ok: true, data: { userId: "user-1" } });
  });

  it("rejects an anonymous caller with unauthenticated and does not redirect", async () => {
    signedInAs(null);
    await expect(authorizeAction()).resolves.toEqual({
      ok: false,
      error: "unauthenticated",
    });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("rejects a signed-in user whose email is not approved", async () => {
    vi.stubEnv("ADMIN_EMAIL", "teacher@example.test");
    signedInAs({ id: "user-2", email: "stranger@example.test" });
    await expect(authorizeAction()).resolves.toEqual({
      ok: false,
      error: "unauthenticated",
    });
  });
});
