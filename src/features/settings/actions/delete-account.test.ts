import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeSignedIn: vi.fn(),
  deleteAccount: vi.fn(),
  signOutUser: vi.fn(),
  getAuthPort: vi.fn(),
  clearFakeSession: vi.fn(),
  redirect: vi.fn((path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));

vi.mock("@/features/auth", async () => ({
  ...(await vi.importActual<object>("@/features/auth/schema/auth-forms")),
  ...(await vi.importActual<object>("@/features/auth/schema/account-forms")),
  authorizeSignedIn: mocks.authorizeSignedIn,
  deleteAccount: mocks.deleteAccount,
  signOutUser: mocks.signOutUser,
  getAuthPort: mocks.getAuthPort,
  clearFakeSession: mocks.clearFakeSession,
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import { deleteAccountAction } from "./delete-account";

const CREATED = new Date("2026-11-18T08:00:00Z");
const SIGNED_IN = {
  ok: true,
  data: {
    status: "allowed",
    userId: "user-1",
    email: "guru@example.test",
    displayName: null,
    sessionCreatedAt: CREATED,
  },
};

function form(confirmEmail: string, extra: Record<string, string> = {}): FormData {
  const data = new FormData();
  data.set("confirmEmail", confirmEmail);
  for (const [name, value] of Object.entries(extra)) data.set(name, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeSignedIn.mockResolvedValue(SIGNED_IN);
  mocks.deleteAccount.mockResolvedValue({ ok: true, data: undefined });
  mocks.signOutUser.mockResolvedValue({ ok: true, data: undefined });
});

describe("deleteAccountAction", () => {
  it("deletes the signed-in account, signs out and goes to /sign-in with a neutral notice", async () => {
    await expect(
      deleteAccountAction(
        {},
        // Another user's id or address in the form changes nothing: the session decides.
        form("guru@example.test", {
          userId: "someone-else",
          email: "other@example.test",
          currentPassword: "rahasia123",
        }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT:/sign-in?notice=accountDeleted");
    expect(mocks.deleteAccount).toHaveBeenCalledWith({
      userId: "user-1",
      email: "guru@example.test",
      sessionCreatedAt: CREATED,
      currentPassword: "rahasia123",
    });
    expect(mocks.signOutUser).toHaveBeenCalledWith(mocks.getAuthPort);
    expect(mocks.clearFakeSession).toHaveBeenCalledTimes(1);
  });

  it("delete account requires typing the account email exactly", async () => {
    for (const typed of [
      "",
      "guru@example",
      "Guru@Example.test",
      "other@example.test",
      "guru@example.test.",
    ]) {
      expect(await deleteAccountAction({}, form(typed)), JSON.stringify(typed)).toEqual({
        fieldErrors: { confirmEmail: "emailMismatch" },
      });
    }
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
    expect(mocks.signOutUser).not.toHaveBeenCalled();
    // Surrounding spaces from a paste are not part of what was typed.
    await expect(deleteAccountAction({}, form("  guru@example.test "))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
  });

  it("changes nothing for an anonymous caller", async () => {
    mocks.authorizeSignedIn.mockResolvedValue({ ok: false, error: "unauthenticated" });
    expect(await deleteAccountAction({}, form("guru@example.test"))).toEqual({
      error: "unauthenticated",
    });
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("keeps the session and says so when the deletion fails", async () => {
    mocks.deleteAccount.mockResolvedValue({ ok: false, error: "generic" });
    expect(await deleteAccountAction({}, form("guru@example.test"))).toEqual({
      error: "generic",
    });
    expect(mocks.signOutUser).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("still leaves for /sign-in when the sign-out call fails after the deletion", async () => {
    mocks.signOutUser.mockResolvedValue({ ok: false, error: "generic" });
    await expect(deleteAccountAction({}, form("guru@example.test"))).rejects.toThrow(
      "NEXT_REDIRECT:/sign-in?notice=accountDeleted",
    );
  });

  it.each([
    ["wrongPassword", { fieldErrors: { currentPassword: "wrongPassword" } }],
    ["passwordRequired", { fieldErrors: { currentPassword: "passwordRequired" } }],
    ["rateLimited", { error: "rateLimited" }],
    ["signInAgain", { error: "signInAgain" }],
    ["generic", { error: "generic" }],
  ])("keeps the account and the session on %s", async (error, expected) => {
    mocks.deleteAccount.mockResolvedValue({ ok: false, error });
    expect(await deleteAccountAction({}, form("guru@example.test"))).toEqual(expected);
    expect(mocks.signOutUser).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("an account that is already gone ends the same way as a deletion", async () => {
    mocks.deleteAccount.mockResolvedValue({ ok: false, error: "notFound" });
    await expect(deleteAccountAction({}, form("guru@example.test"))).rejects.toThrow(
      "NEXT_REDIRECT:/sign-in?notice=accountDeleted",
    );
    expect(mocks.signOutUser).toHaveBeenCalledTimes(1);
  });
});

describe("deleteAccountAction for a pending account", () => {
  it("lets a pending user delete the account", async () => {
    mocks.authorizeSignedIn.mockResolvedValue({
      ok: true,
      data: { ...SIGNED_IN.data, status: "pending" },
    });
    await expect(deleteAccountAction({}, form("guru@example.test"))).rejects.toThrow(
      "NEXT_REDIRECT:/sign-in?notice=accountDeleted",
    );
    expect(mocks.deleteAccount).toHaveBeenCalledTimes(1);
  });
});
