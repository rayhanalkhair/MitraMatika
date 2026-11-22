// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";

vi.mock("@/features/settings/actions/set-locale", () => ({ setLocaleAction: vi.fn() }));

import { AuthCard } from "./AuthCard";

afterEach(cleanup);

describe("AuthCard", () => {
  it("renders the brand, one h1, the description, the content and the footer in a main landmark", () => {
    renderWithIntl(
      <AuthCard title="Masuk" description="Masuk untuk melanjutkan." footer={<p>kaki</p>}>
        <p>isi</p>
      </AuthCard>,
    );
    const main = screen.getByRole("main");
    expect(main.textContent).toContain("MitraMatika");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Masuk" })).toBeTruthy();
    expect(screen.getByText("Masuk untuk melanjutkan.")).toBeTruthy();
    expect(screen.getByText("isi")).toBeTruthy();
    expect(screen.getByText("kaki")).toBeTruthy();
  });

  it("uses the 12 px card radius and a minimum height so states do not jump", () => {
    renderWithIntl(
      <AuthCard title="T">
        <p>isi</p>
      </AuthCard>,
    );
    const card = screen.getByTestId("auth-card");
    expect(card.className).toContain("rounded-xl");
    expect(card.className).toMatch(/\bmin-h-/);
  });

  it("offers the language switch on every auth screen", () => {
    renderWithIntl(
      <AuthCard title="T">
        <p>isi</p>
      </AuthCard>,
    );
    expect(screen.getByRole("group", { name: "Bahasa tampilan" })).toBeTruthy();
  });

  it("leaves out the description and footer when none is given", () => {
    const { container } = renderWithIntl(
      <AuthCard title="T">
        <p>isi</p>
      </AuthCard>,
    );
    expect(container.querySelector("[data-slot='auth-footer']")).toBeNull();
    expect(container.querySelector("[data-slot='auth-description']")).toBeNull();
  });
});
