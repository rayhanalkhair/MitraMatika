// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";

vi.mock("next/navigation", () => ({ usePathname: () => "/home" }));
vi.mock("@/features/auth/ui/SignOutButton", () => ({
  SignOutButton: () => <button>Keluar</button>,
}));

import { Sidebar } from "./Sidebar";

afterEach(cleanup);

const user = { name: "Siti Rahma", email: "siti@example.test" };

function labelsIn(list: HTMLElement): string[] {
  return within(list)
    .getAllByRole("link")
    .map((link) => link.textContent);
}

describe("Sidebar", () => {
  it("lists the eight live sections under Menu utama", () => {
    renderWithIntl(<Sidebar user={user} />);
    const group = screen.getByRole("list", { name: "Menu utama" });
    expect(labelsIn(group)).toEqual([
      "Beranda",
      "Buat Soal",
      "Bank Soal",
      "Selesaikan",
      "Materi Pembelajaran",
      "Penyusun Asesmen",
      "Sampah",
      "Pengaturan",
    ]);
    const hrefs = within(group)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual([
      "/home",
      "/generate",
      "/question-bank",
      "/solve",
      "/materials",
      "/assessment-builder",
      "/trash",
      "/settings",
    ]);
  });

  it("shows no Segera hadir group while no section is coming soon", () => {
    renderWithIntl(<Sidebar user={user} />);
    expect(screen.queryByRole("list", { name: "Segera hadir" })).toBeNull();
    expect(screen.queryByText("Segera hadir")).toBeNull();
    expect(screen.queryByText("Segera")).toBeNull();
  });

  it("keeps /more out of the sidebar", () => {
    renderWithIntl(<Sidebar user={user} />);
    const hrefs = screen.getAllByRole("link").map((l) => l.getAttribute("href"));
    expect(hrefs).not.toContain("/more");
    expect(hrefs).toHaveLength(8);
  });

  it("is 288 px wide and carries the user card at the bottom", () => {
    renderWithIntl(<Sidebar user={user} />);
    const nav = screen.getByRole("navigation", { name: "Menu utama" });
    expect(nav.className).toContain("w-72");
    expect(within(nav).getByText("Siti Rahma")).toBeTruthy();
    expect(within(nav).getByRole("button", { name: "Keluar" })).toBeTruthy();
  });
});
