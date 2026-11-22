import { afterEach, describe, expect, it, vi } from "vitest";

const { requireAllowedUserMock, AppShellStub } = vi.hoisted(() => ({
  requireAllowedUserMock: vi.fn(),
  AppShellStub: () => null,
}));

vi.mock("@/features/auth/service/guard", () => ({
  requireAllowedUser: requireAllowedUserMock,
}));
vi.mock("@/components/shell/AppShell", () => ({ AppShell: AppShellStub }));

import ShellLayout from "./layout";

afterEach(() => {
  vi.clearAllMocks();
  requireAllowedUserMock.mockReset();
});

describe("ShellLayout", () => {
  it("rejects with the guard's redirect and renders nothing when access is refused", async () => {
    requireAllowedUserMock.mockRejectedValue(new Error("NEXT_REDIRECT:/sign-in"));
    await expect(ShellLayout({ children: null })).rejects.toThrow(
      "NEXT_REDIRECT:/sign-in",
    );
  });

  it("renders the app shell around the children for an allowed user", async () => {
    requireAllowedUserMock.mockResolvedValue({
      status: "allowed",
      userId: "user-1",
      email: "teacher@example.test",
      displayName: null,
    });
    const children = "page content";
    const element = await ShellLayout({ children });
    expect(element.type).toBe(AppShellStub);
    expect((element.props as { children: unknown }).children).toBe(children);
  });

  it("passes the user name and email to the app shell", async () => {
    requireAllowedUserMock.mockResolvedValue({
      status: "allowed",
      userId: "user-1",
      email: "teacher@example.test",
      displayName: "Bu Guru",
    });
    const element = await ShellLayout({ children: null });
    expect((element.props as { user: unknown }).user).toEqual({
      name: "Bu Guru",
      email: "teacher@example.test",
    });
  });

  it("calls the guard exactly once per render", async () => {
    requireAllowedUserMock.mockResolvedValue({ status: "allowed" });
    await ShellLayout({ children: null });
    expect(requireAllowedUserMock).toHaveBeenCalledTimes(1);
  });
});
