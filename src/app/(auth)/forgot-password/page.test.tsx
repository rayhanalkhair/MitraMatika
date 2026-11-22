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
vi.mock("@/features/settings/actions/set-locale", () => ({ setLocaleAction: vi.fn() }));
vi.mock("@/features/auth/actions/forgot-password", () => ({
  requestPasswordResetAction: vi.fn(),
}));

import ForgotPasswordPage from "./page";

afterEach(cleanup);

describe("forgot-password page", () => {
  it("asks for the address, links back to sign in and offers the language switch", async () => {
    renderWithIntl(await ForgotPasswordPage());
    expect(
      screen.getByRole("heading", { level: 1, name: "Lupa kata sandi" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Kembali ke halaman masuk" }).getAttribute("href"),
    ).toBe("/sign-in");
    expect(screen.getByRole("group", { name: "Bahasa tampilan" })).toBeTruthy();
  });
});
