// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";
import { Calculator } from "lucide-react";

vi.mock("next/navigation", () => ({ usePathname: () => "/home" }));

import { NavItem } from "./NavItem";

afterEach(cleanup);

const item = {
  href: "/solve",
  labelKey: "selesaikan" as const,
  icon: Calculator,
  group: "soon" as const,
};

describe("NavItem", () => {
  it("shows a visible Segera badge, readable by screen readers, for a coming-soon item", () => {
    renderWithIntl(
      <NavItem
        item={{ ...item, mobileBottomNav: true, comingSoon: true }}
        orientation="vertical"
      />,
    );
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/solve");
    expect(link.textContent).toContain("Selesaikan");
    expect(screen.getByText("Segera")).toBeTruthy();
    expect(link.querySelector('[aria-hidden="true"]:not(svg)')).toBeNull();
    expect(link.getAttribute("aria-label")).toBeNull();
  });

  it("keeps a sidebar label and its Segera chip on one line (S-18)", () => {
    renderWithIntl(
      <NavItem
        item={{
          ...item,
          labelKey: "materi" as const,
          mobileBottomNav: true,
          comingSoon: true,
        }}
        orientation="vertical"
      />,
    );
    expect(screen.getByText("Materi Pembelajaran").className).toContain(
      "whitespace-nowrap",
    );
    const chip = screen.getByText("Segera");
    expect(chip.className).toContain("whitespace-nowrap");
    expect(chip.className).toContain("text-[10px]");
    expect(screen.getByRole("link").textContent).toBe("Materi PembelajaranSegera");
  });

  it("keeps the link name but shows only a dot, not a stacked chip, in the bottom bar", () => {
    renderWithIntl(
      <NavItem
        item={{ ...item, mobileBottomNav: true, comingSoon: true }}
        orientation="horizontal"
      />,
    );
    const text = screen.getByText("Segera");
    expect(text.className).toContain("sr-only");
    expect(screen.getByRole("link").textContent).toContain("Segera");
  });

  it("has no badge for a finished section", () => {
    renderWithIntl(
      <NavItem item={{ ...item, mobileBottomNav: true }} orientation="vertical" />,
    );
    expect(screen.queryByText("Segera")).toBeNull();
  });
});
