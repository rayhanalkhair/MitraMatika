import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeAction: vi.fn(),
  saveAccountProfile: vi.fn(),
  revalidatePath: vi.fn(),
}));

// The real form parsers; only the session and the database are faked.
vi.mock("@/features/auth", async () => ({
  ...(await vi.importActual<object>("@/features/auth/schema/auth-forms")),
  ...(await vi.importActual<object>("@/features/auth/schema/account-forms")),
  authorizeAction: mocks.authorizeAction,
  saveAccountProfile: mocks.saveAccountProfile,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import { updateProfileAction } from "./update-profile";

const SIGNED_IN = {
  ok: true,
  data: {
    status: "allowed",
    userId: "user-1",
    email: "guru@example.test",
    displayName: null,
  },
};

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeAction.mockResolvedValue(SIGNED_IN);
  mocks.saveAccountProfile.mockResolvedValue({ ok: true, data: undefined });
});

describe("updateProfileAction", () => {
  it("saves the trimmed name and school for the signed-in user only", async () => {
    const state = await updateProfileAction(
      {},
      // A user id in the form is ignored: the id comes from the session.
      form({ name: "  Bu Sari  ", schoolName: "  SMP 2 ", userId: "someone-else" }),
    );
    expect(mocks.saveAccountProfile).toHaveBeenCalledWith({
      userId: "user-1",
      name: "Bu Sari",
      schoolName: "SMP 2",
    });
    expect(state.savedAt).toEqual(expect.any(Number));
    expect(state.values).toEqual({ name: "Bu Sari", schoolName: "SMP 2" });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("stores no school when it is left blank", async () => {
    await updateProfileAction({}, form({ name: "Bu Sari", schoolName: "   " }));
    expect(mocks.saveAccountProfile).toHaveBeenCalledWith({
      userId: "user-1",
      name: "Bu Sari",
      schoolName: null,
    });
  });

  it("rejects an empty or too long name and a too long school, keeping what was typed", async () => {
    const state = await updateProfileAction(
      {},
      form({ name: "   ", schoolName: "s".repeat(121) }),
    );
    expect(state.fieldErrors).toEqual({
      name: "nameLength",
      schoolName: "schoolNameTooLong",
    });
    expect(state.values).toEqual({ name: "   ", schoolName: "s".repeat(121) });
    expect(
      (await updateProfileAction({}, form({ name: "x".repeat(81) }))).fieldErrors,
    ).toEqual({ name: "nameLength" });
    expect(mocks.saveAccountProfile).not.toHaveBeenCalled();
  });

  it("changes nothing for an anonymous caller", async () => {
    mocks.authorizeAction.mockResolvedValue({ ok: false, error: "unauthenticated" });
    expect(await updateProfileAction({}, form({ name: "Bu Sari" }))).toEqual({
      error: "unauthenticated",
    });
    expect(mocks.saveAccountProfile).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("answers generic when the save fails", async () => {
    mocks.saveAccountProfile.mockResolvedValue({ ok: false, error: "generic" });
    const state = await updateProfileAction({}, form({ name: "Bu Sari" }));
    expect(state.error).toBe("generic");
    expect(state.savedAt).toBeUndefined();
  });
});
