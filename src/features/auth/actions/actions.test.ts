import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
  signOutUser: vi.fn(),
  getAuthPort: vi.fn(),
  clearFakeSession: vi.fn(),
  authorizeAction: vi.fn(),
  auditSignOut: vi.fn(() => Promise.resolve()),
  forgetPendingEmail: vi.fn(() => Promise.resolve()),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("../service/port-server", () => ({ getAuthPort: mocks.getAuthPort }));
vi.mock("../service/guard", () => ({ authorizeAction: mocks.authorizeAction }));
vi.mock("../service/audit", () => ({ auditSignOut: mocks.auditSignOut }));
vi.mock("../service/e2e-session-server", () => ({
  clearFakeSession: mocks.clearFakeSession,
}));
vi.mock("../service/core", () => ({ signOutUser: mocks.signOutUser }));
vi.mock("../service/pending-email", () => ({
  forgetPendingEmail: mocks.forgetPendingEmail,
}));

import * as actions from "./actions";

const { signOutAction } = actions;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("auth actions", () => {
  it("exports sign-out only: the email-code action is gone", () => {
    expect(Object.keys(actions).sort()).toEqual(["signOutAction"]);
  });
});

describe("signOutAction", () => {
  it("signs the user out and then redirects to /sign-in", async () => {
    mocks.signOutUser.mockResolvedValue({ ok: true });
    mocks.authorizeAction.mockResolvedValue({
      ok: true,
      data: { status: "allowed", userId: "u1", email: "t@e.st", displayName: null },
    });

    await expect(signOutAction()).rejects.toThrow("NEXT_REDIRECT:/sign-in");

    expect(mocks.signOutUser).toHaveBeenCalledWith(expect.any(Function));
    expect(mocks.redirect).toHaveBeenCalledWith("/sign-in");
    expect(mocks.clearFakeSession).toHaveBeenCalledTimes(1);
    expect(mocks.forgetPendingEmail).toHaveBeenCalledTimes(1);
    expect(mocks.auditSignOut).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1" }),
    );
  });

  it("still signs out and redirects, without auditing, when nobody is signed in", async () => {
    mocks.signOutUser.mockResolvedValue({ ok: true });
    mocks.authorizeAction.mockResolvedValue({ ok: false, error: "unauthenticated" });

    await expect(signOutAction()).rejects.toThrow("NEXT_REDIRECT:/sign-in");

    expect(mocks.signOutUser).toHaveBeenCalledTimes(1);
    expect(mocks.redirect).toHaveBeenCalledWith("/sign-in");
    expect(mocks.auditSignOut).not.toHaveBeenCalled();
  });

  it("still redirects to /sign-in when signing out fails", async () => {
    mocks.signOutUser.mockResolvedValue({ ok: false, error: "generic" });
    mocks.authorizeAction.mockResolvedValue({ ok: false, error: "unauthenticated" });

    await expect(signOutAction()).rejects.toThrow("NEXT_REDIRECT:/sign-in");

    expect(mocks.signOutUser).toHaveBeenCalledTimes(1);
    expect(mocks.redirect).toHaveBeenCalledWith("/sign-in");
  });
});
