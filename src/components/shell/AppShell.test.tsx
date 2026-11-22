// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";

vi.mock("next/navigation", () => ({ usePathname: () => "/home" }));
vi.mock("@/features/auth/ui/SignOutButton", () => ({
  SignOutButton: () => <button>Keluar</button>,
}));

import { AppShell } from "./AppShell";

afterEach(cleanup);

const user = { name: "Siti Rahma", email: "siti@example.test" };

describe("AppShell", () => {
  it("makes the skip link the first focusable element, targeting the main landmark", () => {
    const { container } = renderWithIntl(
      <AppShell user={user}>
        <p>isi</p>
      </AppShell>,
    );
    const focusables = container.querySelectorAll("a[href], button");
    const first = focusables[0] as HTMLAnchorElement;
    expect(first.textContent).toBe("Lewati ke konten utama");
    expect(first.getAttribute("href")).toBe("#main-content");

    const main = screen.getByRole("main");
    expect(main.id).toBe("main-content");
    expect(main.getAttribute("tabindex")).toBe("-1");
  });

  it("gives the two navigation landmarks distinct names", () => {
    renderWithIntl(
      <AppShell user={user}>
        <p>isi</p>
      </AppShell>,
    );
    // jsdom has no CSS, so both navs are present: sidebar and bottom bar.
    const names = screen
      .getAllByRole("navigation")
      .map((n) => n.getAttribute("aria-label"));
    expect(names).toEqual(["Menu utama", "Menu bawah"]);
  });

  it("gives main the main-content id and clears the bottom bar", () => {
    renderWithIntl(
      <AppShell user={user}>
        <p>isi</p>
      </AppShell>,
    );
    const main = screen.getByRole("main");
    expect(main.id).toBe("main-content");
    expect(main.className).toContain(
      "pb-[calc(var(--bottom-nav-h)+0.5rem+env(safe-area-inset-bottom))]",
    );
    expect(main.className).toContain("md:pb-0");
  });

  it("renders the top bar banner above the content", () => {
    renderWithIntl(
      <AppShell user={user}>
        <p>isi</p>
      </AppShell>,
    );
    expect(screen.getByRole("banner")).toBeTruthy();
  });
});
