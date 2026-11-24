// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { createTranslator } from "next-intl";
import { renderWithIntl } from "@/test/intl";
import idMessages from "../../../../messages/id.json";

const pending = vi.hoisted(() => ({
  read: vi.fn<() => Promise<string | undefined>>(() => Promise.resolve(undefined)),
}));

vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: "auth") =>
    Promise.resolve(createTranslator({ locale: "id", messages: idMessages, namespace })),
}));
vi.mock("@/features/settings/actions/set-locale", () => ({ setLocaleAction: vi.fn() }));
vi.mock("@/features/auth/actions/verify-email", () => ({
  resendVerificationAction: vi.fn(),
}));
vi.mock("@/features/auth/service/pending-email", () => ({
  readPendingEmail: pending.read,
}));

import VerifyEmailPage from "./page";

beforeEach(() => {
  pending.read.mockResolvedValue(undefined);
});
afterEach(cleanup);

async function renderPage(query: { error?: string } = {}) {
  const ui = await VerifyEmailPage({
    searchParams: Promise.resolve(query),
  } as Parameters<typeof VerifyEmailPage>[0]);
  return renderWithIntl(ui);
}

describe("verify-email page", () => {
  it("after sign-up: check your email, the remembered address and a resend on a countdown", async () => {
    pending.read.mockResolvedValue("rina@example.test");
    await renderPage();
    expect(
      screen.getByRole("heading", { level: 1, name: "Cek email Anda" }),
    ).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Email").value).toBe(
      "rina@example.test",
    );
    const resend = screen.getByRole<HTMLButtonElement>("button", {
      name: "Kirim ulang dalam 60 detik",
    });
    expect(resend.disabled).toBe(true);
    expect(
      screen.getByRole("link", { name: "Kembali ke halaman masuk" }).getAttribute("href"),
    ).toBe("/sign-in");
    expect(screen.getByRole("group", { name: "Bahasa tampilan" })).toBeTruthy();
  });

  it("an expired or invalid link lands here with a way to request a new one right away", async () => {
    await renderPage({ error: "invalid" });
    expect(
      screen.getByRole("heading", { level: 1, name: "Tautan tidak berlaku" }),
    ).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Email").value).toBe("");
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Kirim ulang tautan" })
        .disabled,
    ).toBe(false);
  });
});
