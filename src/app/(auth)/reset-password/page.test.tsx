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
vi.mock("@/features/auth/actions/reset-password", () => ({
  resetPasswordAction: vi.fn(),
}));

import ResetPasswordPage, { generateMetadata } from "./page";

afterEach(cleanup);

async function renderPage(query: { token?: string; error?: string }) {
  const ui = await ResetPasswordPage({
    searchParams: Promise.resolve(query),
  } as Parameters<typeof ResetPasswordPage>[0]);
  return renderWithIntl(ui);
}

describe("reset-password page", () => {
  it("with a token shows the new-password form and carries the token", async () => {
    const { container } = await renderPage({ token: "tok-123" });
    expect(
      screen.getByRole("heading", { level: 1, name: "Buat kata sandi baru" }),
    ).toBeTruthy();
    expect(container.querySelector<HTMLInputElement>("input[name='token']")?.value).toBe(
      "tok-123",
    );
    expect(screen.getByRole("group", { name: "Bahasa tampilan" })).toBeTruthy();
  });

  it.each([{}, { error: "INVALID_TOKEN" }, { token: "tok", error: "INVALID_TOKEN" }])(
    "reset page with a missing or invalid token shows the expired message and a link to request a new one (%o)",
    async (query) => {
      const { container } = await renderPage(query);
      expect(
        screen.getByRole("heading", { level: 1, name: "Tautan tidak berlaku" }),
      ).toBeTruthy();
      expect(
        screen.getByRole("link", { name: "Minta tautan baru" }).getAttribute("href"),
      ).toBe("/forgot-password");
      expect(container.querySelector("form")).toBeNull();
    },
  );

  const metadataFor = (query: { token?: string; error?: string }) =>
    generateMetadata({
      searchParams: Promise.resolve(query),
    } as Parameters<typeof generateMetadata>[0]);

  it("never sends the token to another site as a referrer", async () => {
    expect((await metadataFor({ token: "tok" })).referrer).toBe("no-referrer");
  });

  it("titles the page after what it shows", async () => {
    expect((await metadataFor({ token: "tok" })).title).toBe("Buat kata sandi baru");
    expect((await metadataFor({})).title).toBe("Tautan tidak berlaku");
    expect((await metadataFor({ token: "tok", error: "INVALID_TOKEN" })).title).toBe(
      "Tautan tidak berlaku",
    );
  });
});
