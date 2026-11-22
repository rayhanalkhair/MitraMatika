// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";

const mocks = vi.hoisted(() => ({ setLocaleAction: vi.fn() }));
vi.mock("../actions/set-locale", () => ({ setLocaleAction: mocks.setLocaleAction }));

import { LanguageSwitch } from "./LanguageSwitch";

afterEach(() => {
  cleanup();
  mocks.setLocaleAction.mockReset();
});

describe("LanguageSwitch", () => {
  it("offers both languages by their own names and marks the current one", () => {
    renderWithIntl(<LanguageSwitch />);
    expect(screen.getByRole("group", { name: "Bahasa tampilan" })).toBeTruthy();
    const indonesian = screen.getByRole<HTMLInputElement>("radio", {
      name: "Bahasa Indonesia",
    });
    const english = screen.getByRole<HTMLInputElement>("radio", { name: "English" });
    expect(indonesian.checked).toBe(true);
    expect(english.checked).toBe(false);
    expect(screen.getByRole("heading", { name: "Bahasa" })).toBeTruthy();
  });

  it("labels the same control in English and marks English current", () => {
    renderWithIntl(<LanguageSwitch />, { locale: "en" });
    expect(screen.getByRole("heading", { name: "Language" })).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "English" }).checked).toBe(
      true,
    );
    // Language names stay in their own language.
    expect(screen.getByRole("radio", { name: "Bahasa Indonesia" })).toBeTruthy();
  });

  it("calls the server action with the chosen locale", async () => {
    mocks.setLocaleAction.mockResolvedValue({ ok: true });
    renderWithIntl(<LanguageSwitch />);
    fireEvent.click(screen.getByRole("radio", { name: "English" }));
    await waitFor(() => {
      expect(mocks.setLocaleAction).toHaveBeenCalledWith("en");
    });
  });

  it("does nothing when the current language is chosen again", () => {
    renderWithIntl(<LanguageSwitch />);
    fireEvent.click(screen.getByRole("radio", { name: "Bahasa Indonesia" }));
    expect(mocks.setLocaleAction).not.toHaveBeenCalled();
  });
});
