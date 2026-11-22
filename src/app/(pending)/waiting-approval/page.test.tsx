// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { createTranslator } from "next-intl";
import { renderWithIntl } from "@/test/intl";
import idMessages from "../../../../messages/id.json";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
  requireSignedInUser: vi.fn(),
  loadAccountSettings: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: "approval") =>
    Promise.resolve(createTranslator({ locale: "id", messages: idMessages, namespace })),
}));
vi.mock("@/features/auth", () => ({
  requireSignedInUser: mocks.requireSignedInUser,
  loadAccountSettings: mocks.loadAccountSettings,
}));
vi.mock("@/features/auth/actions/actions", () => ({ signOutAction: vi.fn() }));
vi.mock("@/features/settings/actions/set-locale", () => ({ setLocaleAction: vi.fn() }));
vi.mock("@/features/settings/actions/delete-account", () => ({
  deleteAccountAction: vi.fn(),
}));

import WaitingApprovalPage, { generateMetadata } from "./page";

const pending = {
  status: "pending",
  userId: "user-2",
  email: "baru@example.test",
  displayName: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadAccountSettings.mockResolvedValue({ hasPassword: false });
});
afterEach(cleanup);

describe("waiting-approval page", () => {
  it("shows a pending account its email, the buttons and the delete dialog opener", async () => {
    mocks.requireSignedInUser.mockResolvedValue(pending);
    renderWithIntl(await WaitingApprovalPage());
    expect(screen.getByText("Akun: baru@example.test")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Cek lagi" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keluar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hapus akun" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Pemberitahuan privasi" })).toBeTruthy();
  });

  it("sends an approved account to /home", async () => {
    mocks.requireSignedInUser.mockResolvedValue({ ...pending, status: "allowed" });
    await expect(WaitingApprovalPage()).rejects.toThrow("NEXT_REDIRECT:/home");
  });

  it("lets the guard send an anonymous visitor to /sign-in", async () => {
    mocks.requireSignedInUser.mockRejectedValue(new Error("NEXT_REDIRECT:/sign-in"));
    await expect(WaitingApprovalPage()).rejects.toThrow("NEXT_REDIRECT:/sign-in");
  });

  it("still renders when the account settings cannot be read", async () => {
    mocks.requireSignedInUser.mockResolvedValue(pending);
    mocks.loadAccountSettings.mockResolvedValue(null);
    renderWithIntl(await WaitingApprovalPage());
    expect(screen.getByRole("button", { name: "Hapus akun" })).toBeTruthy();
  });

  it("has the page title", async () => {
    expect(await generateMetadata()).toEqual({ title: "Menunggu persetujuan admin" });
  });
});
