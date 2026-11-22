import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeAction: vi.fn(),
  changeAccountPassword: vi.fn(),
}));

// The real form parsers; only the session and the password change are faked.
vi.mock("@/features/auth", async () => ({
  ...(await vi.importActual<object>("@/features/auth/schema/auth-forms")),
  ...(await vi.importActual<object>("@/features/auth/schema/account-forms")),
  authorizeAction: mocks.authorizeAction,
  changeAccountPassword: mocks.changeAccountPassword,
}));

import { changePasswordAction } from "./change-password";

const SIGNED_IN = {
  ok: true,
  data: {
    status: "allowed",
    userId: "user-1",
    email: "guru@example.test",
    displayName: null,
  },
};
const VALID = {
  currentPassword: "lama12345",
  newPassword: "baru12345",
  confirmPassword: "baru12345",
};

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeAction.mockResolvedValue(SIGNED_IN);
  mocks.changeAccountPassword.mockResolvedValue({ ok: true, data: undefined });
});

describe("changePasswordAction", () => {
  it("changes the password of the signed-in user only", async () => {
    const state = await changePasswordAction(
      {},
      form({ ...VALID, userId: "someone-else" }),
    );
    expect(mocks.changeAccountPassword).toHaveBeenCalledWith({
      userId: "user-1",
      currentPassword: "lama12345",
      newPassword: "baru12345",
    });
    expect(Object.keys(state)).toEqual(["savedAt"]);
    expect(typeof state.savedAt).toBe("number");
  });

  it("needs the current password and applies the policy and the confirmation", async () => {
    const state = await changePasswordAction(
      {},
      form({ currentPassword: "", newPassword: "hanyahuruf", confirmPassword: "lain" }),
    );
    expect(state.fieldErrors).toEqual({
      currentPassword: "passwordRequired",
      newPassword: "passwordNeedsLetterAndDigit",
      confirmPassword: "passwordMismatch",
    });
    expect(mocks.changeAccountPassword).not.toHaveBeenCalled();
  });

  it("says only that the current password is wrong", async () => {
    mocks.changeAccountPassword.mockResolvedValue({ ok: false, error: "wrongPassword" });
    const state = await changePasswordAction({}, form(VALID));
    expect(state).toEqual({ fieldErrors: { currentPassword: "wrongPassword" } });
  });

  it.each([
    ["rateLimited", "rateLimited"],
    ["invalidInput", "generic"],
    ["generic", "generic"],
  ])("maps %s to the form error %s", async (error, expected) => {
    mocks.changeAccountPassword.mockResolvedValue({ ok: false, error });
    expect(await changePasswordAction({}, form(VALID))).toEqual({ error: expected });
  });

  it("changes nothing for an anonymous caller", async () => {
    mocks.authorizeAction.mockResolvedValue({ ok: false, error: "unauthenticated" });
    expect(await changePasswordAction({}, form(VALID))).toEqual({
      error: "unauthenticated",
    });
    expect(mocks.changeAccountPassword).not.toHaveBeenCalled();
  });

  it("never sends a password back in the form state", async () => {
    for (const result of [
      { ok: false, error: "wrongPassword" },
      { ok: false, error: "generic" },
      { ok: true, data: undefined },
    ]) {
      mocks.changeAccountPassword.mockResolvedValue(result);
      const state = await changePasswordAction({}, form(VALID));
      expect(JSON.stringify(state)).not.toMatch(/lama12345|baru12345/);
    }
  });
});

describe("changePasswordAction confirmation", () => {
  it("refuses a valid new password typed differently the second time", async () => {
    mocks.authorizeAction.mockResolvedValue(SIGNED_IN);
    const state = await changePasswordAction(
      {},
      form({
        currentPassword: "lama12345",
        newPassword: "baru12345",
        confirmPassword: "baru12346",
      }),
    );
    expect(state.fieldErrors).toEqual({ confirmPassword: "passwordMismatch" });
    expect(mocks.changeAccountPassword).not.toHaveBeenCalled();
  });
});
