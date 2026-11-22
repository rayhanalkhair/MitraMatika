import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
  requireSignedInUser: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/features/auth", () => ({ requireSignedInUser: mocks.requireSignedInUser }));

import PendingLayout from "./layout";

afterEach(() => {
  vi.clearAllMocks();
});

describe("PendingLayout", () => {
  it("renders the children for a pending account", async () => {
    mocks.requireSignedInUser.mockResolvedValue({ status: "pending" });
    const element = await PendingLayout({ children: "page" });
    expect((element.props as { children: unknown }).children).toBe("page");
  });

  it("sends an approved account to /home", async () => {
    mocks.requireSignedInUser.mockResolvedValue({ status: "allowed" });
    await expect(PendingLayout({ children: "page" })).rejects.toThrow(
      "NEXT_REDIRECT:/home",
    );
  });

  it("lets the guard's /sign-in redirect through for an anonymous visitor", async () => {
    mocks.requireSignedInUser.mockRejectedValue(new Error("NEXT_REDIRECT:/sign-in"));
    await expect(PendingLayout({ children: "page" })).rejects.toThrow(
      "NEXT_REDIRECT:/sign-in",
    );
  });
});
