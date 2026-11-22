// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";

vi.mock("@/features/auth", () => ({
  requireAllowedUser: () =>
    Promise.resolve({
      userId: "u1",
      email: "siti@example.test",
      displayName: "Siti Rahmawati",
    }),
}));
vi.mock("@/features/auth/actions/actions", () => ({ signOutAction: vi.fn() }));

import MorePage from "./page";

afterEach(cleanup);

describe("More", () => {
  it("lists Materi, Penyusun asesmen, Sampah, Pengaturan, all live, and the sign-out button, plus the user card", async () => {
    renderWithIntl(await MorePage());
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);

    const list = screen.getByRole("list");
    const rows = within(list).getAllByRole("link");
    expect(rows.map((row) => row.getAttribute("href"))).toEqual([
      "/materials",
      "/assessment-builder",
      "/trash",
      "/settings",
    ]);
    expect(rows[0]?.textContent).toContain("Materi Pembelajaran");
    expect(rows[1]?.textContent).toContain("Penyusun Asesmen");
    expect(rows[2]?.textContent).toContain("Sampah");
    expect(rows[3]?.textContent).toContain("Pengaturan");
    // Every row here is live now (Materi since the materials library).
    expect(within(rows[0]).queryByText("Segera")).toBeNull();
    expect(within(rows[1]).queryByText("Segera")).toBeNull();
    expect(within(rows[2]).queryByText("Segera")).toBeNull();
    expect(within(rows[3]).queryByText("Segera")).toBeNull();

    expect(screen.getByText("Siti Rahmawati")).toBeTruthy();
    expect(screen.getByText("siti@example.test")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keluar" })).toBeTruthy();
  });

  it("hides the user card from md up, where the sidebar already shows it", async () => {
    renderWithIntl(await MorePage());
    const card = screen
      .getByRole("button", { name: "Keluar" })
      .closest("div.md\\:hidden");
    expect(card).not.toBeNull();
  });

  it("invents no school, NIP or service-status data", async () => {
    const { container } = renderWithIntl(await MorePage());
    expect(container.textContent).not.toMatch(/NIP|Belajar\.id|SMPN|latensi/i);
  });
});
