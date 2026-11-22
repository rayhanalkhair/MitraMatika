// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";

vi.mock("next/navigation", () => ({ usePathname: () => "/home" }));

import { BottomNav } from "./BottomNav";

afterEach(cleanup);

describe("BottomNav", () => {
  it("renders Beranda, Buat Soal, Bank Soal, Selesaikan and Lainnya in order", () => {
    renderWithIntl(<BottomNav />);
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/home",
      "/generate",
      "/question-bank",
      "/solve",
      "/more",
    ]);
    expect(screen.getByText("Beranda")).toBeTruthy();
    expect(screen.getByText("Buat Soal")).toBeTruthy();
    expect(screen.getByText("Bank Soal")).toBeTruthy();
    expect(screen.getByText("Selesaikan")).toBeTruthy();
    expect(screen.getByText("Lainnya")).toBeTruthy();
  });

  it("keeps every label on one line and the bar clear of the safe area", () => {
    renderWithIntl(<BottomNav />);
    for (const label of ["Beranda", "Buat Soal", "Bank Soal", "Selesaikan", "Lainnya"]) {
      expect(screen.getByText(label).className).toContain("whitespace-nowrap");
    }
    expect(screen.getByRole("navigation").className).toContain(
      "env(safe-area-inset-bottom)",
    );
  });
});
