// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { createTranslator } from "next-intl";
import { renderWithIntl } from "@/test/intl";
import idMessages from "../../../../messages/id.json";

vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: "auth") =>
    Promise.resolve(createTranslator({ locale: "id", messages: idMessages, namespace })),
}));
vi.mock("@/features/auth/service/auth-client", () => ({
  authClient: { signIn: { social: vi.fn() } },
}));
vi.mock("@/features/settings/actions/set-locale", () => ({ setLocaleAction: vi.fn() }));
vi.mock("@/features/auth/actions/sign-in", () => ({ signInAction: vi.fn() }));

import MasukPage from "./page";

afterEach(cleanup);

async function renderPage(error?: string, notice?: string) {
  const ui = await MasukPage({
    searchParams: Promise.resolve({
      ...(error ? { error } : {}),
      ...(notice ? { notice } : {}),
    }),
  } as Parameters<typeof MasukPage>[0]);
  return renderWithIntl(ui);
}

describe("sign-in page", () => {
  it("sign-in shows Google first, then email and password, links to sign-up and forgot password", async () => {
    const { container } = await renderPage();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Masuk" })).toBeTruthy();
    const google = screen.getByRole("button", { name: "Masuk dengan Google" });
    const email = screen.getByLabelText("Email");
    const password = screen.getByLabelText("Kata sandi");
    const follows = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(google, email)).toBe(true);
    expect(follows(email, password)).toBe(true);
    expect(screen.getByText("atau")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Daftar" }).getAttribute("href")).toBe(
      "/sign-up",
    );
    expect(
      screen.getByRole("link", { name: "Lupa kata sandi?" }).getAttribute("href"),
    ).toBe("/forgot-password");
    expect(container.querySelectorAll("form")).toHaveLength(1);
  });

  it("never mentions Belajar.id", async () => {
    await renderPage();
    expect(screen.queryByText(/belajar\.id/i)).toBeNull();
  });

  it("shows the password-reset notice as a status message", async () => {
    await renderPage(undefined, "passwordReset");
    expect(screen.getByRole("status").textContent).toBe(
      "Kata sandi baru sudah disimpan. Masuk dengan kata sandi itu.",
    );
  });

  it("explains a used verification link and offers a new one", async () => {
    await renderPage(undefined, "linkUsed");
    expect(screen.getByRole("status").textContent).toContain(
      "Tautan konfirmasi ini sudah dipakai atau tidak berlaku lagi.",
    );
    expect(
      screen
        .getByRole("link", { name: "Kirim ulang tautan konfirmasi" })
        .getAttribute("href"),
    ).toBe("/verify-email");
  });

  it("confirms a deleted account with a neutral notice", async () => {
    await renderPage(undefined, "accountDeleted");
    expect(screen.getByRole("status").textContent).toBe("Akun Anda sudah dihapus.");
  });

  it("ignores an unknown notice", async () => {
    await renderPage(undefined, "toString");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers both languages and marks the current one", async () => {
    await renderPage();
    expect(screen.getByRole("group", { name: "Bahasa tampilan" })).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Bahasa Indonesia" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "English" }).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("shows a known error from the query string", async () => {
    await renderPage("oauthDenied");
    expect(screen.getByRole("alert").textContent).toBe(
      "Masuk dengan Google dibatalkan atau ditolak.",
    );
  });

  it("ignores an unknown error key, including the removed noAccess", async () => {
    await renderPage("noAccess");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
