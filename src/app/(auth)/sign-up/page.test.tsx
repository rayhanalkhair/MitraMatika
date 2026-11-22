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
vi.mock("@/features/auth/actions/sign-up", () => ({ signUpAction: vi.fn() }));

import SignUpPage from "./page";

afterEach(cleanup);

describe("sign-up page", () => {
  it("offers Google, then the sign-up form, a link to sign in and the language switch", async () => {
    renderWithIntl(await SignUpPage());
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Daftar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Daftar dengan Google" })).toBeTruthy();
    expect(screen.getByLabelText("Nama lengkap")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Masuk" }).getAttribute("href")).toBe(
      "/sign-in",
    );
    expect(screen.getByRole("group", { name: "Bahasa tampilan" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/belajar\.id/i);
  });
});
