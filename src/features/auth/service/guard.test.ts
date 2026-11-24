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

import {
  authorizeAction,
  authorizeSignedIn,
  requireAllowedUser,
  requireSignedInUser,
} from "./guard";

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

  it("sends a pending (signed in, not approved) user to /waiting-approval", async () => {
    vi.stubEnv("ADMIN_EMAIL", "teacher@example.test");
    signedInAs({ id: "user-2", email: "stranger@example.test" });
    await expect(requireAllowedUser()).rejects.toThrow("NEXT_REDIRECT:/waiting-approval");
    expect(mocks.redirect).toHaveBeenCalledWith("/waiting-approval");
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

describe("requireSignedInUser and authorizeSignedIn", () => {
  it("lets a pending user through both", async () => {
    vi.stubEnv("ADMIN_EMAIL", "teacher@example.test");
    signedInAs({ id: "user-2", email: "stranger@example.test" });
    await expect(requireSignedInUser()).resolves.toMatchObject({
      status: "pending",
      userId: "user-2",
    });
    await expect(authorizeSignedIn()).resolves.toMatchObject({
      ok: true,
      data: { status: "pending", userId: "user-2" },
    });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("lets an approved user through both", async () => {
    vi.stubEnv("ADMIN_EMAIL", "teacher@example.test");
    signedInAs({ id: "user-1", email: "teacher@example.test" });
    await expect(requireSignedInUser()).resolves.toMatchObject({ status: "allowed" });
    await expect(authorizeSignedIn()).resolves.toMatchObject({
      ok: true,
      data: { status: "allowed" },
    });
  });

  it("sends an anonymous visitor to /sign-in and answers unauthenticated", async () => {
    signedInAs(null);
    await expect(requireSignedInUser()).rejects.toThrow("NEXT_REDIRECT:/sign-in");
    await expect(authorizeSignedIn()).resolves.toEqual({
      ok: false,
      error: "unauthenticated",
    });
  });

  it("fails closed when Better Auth is unreachable", async () => {
    mocks.getAuthPort.mockRejectedValue(new Error("no env"));
    await expect(authorizeSignedIn()).resolves.toEqual({
      ok: false,
      error: "unauthenticated",
    });
  });
});

describe("approval is read from the environment on every request", () => {
  // The per-request memo (React cache) is a no-op in plain Node, so each call below stands for a
  // new request.
  it("flips a signed-in user to pending when the approved address changes", async () => {
    signedInAs({ id: "user-1", email: "teacher@example.test" });
    vi.stubEnv("ADMIN_EMAIL", "teacher@example.test");
    await expect(authorizeAction()).resolves.toMatchObject({ ok: true });

    vi.stubEnv("ADMIN_EMAIL", "someone-else@example.test");
    await expect(authorizeAction()).resolves.toEqual({
      ok: false,
      error: "unauthenticated",
    });
    await expect(requireAllowedUser()).rejects.toThrow("NEXT_REDIRECT:/waiting-approval");
    await expect(authorizeSignedIn()).resolves.toMatchObject({
      ok: true,
      data: { status: "pending" },
    });
  });
});
