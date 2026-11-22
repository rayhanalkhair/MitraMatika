import { describe, expect, it } from "vitest";
import { allNavItems, isNavItemActive, mobileNavItems } from "./nav-config";

describe("allNavItems", () => {
  it("has exactly 9 entries: the 8 IA sections plus /more", () => {
    expect(allNavItems).toHaveLength(9);
  });

  it("has unique hrefs", () => {
    const hrefs = allNavItems.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("excluding /more leaves exactly the 8 real IA sections", () => {
    expect(allNavItems.filter((item) => item.href !== "/more")).toHaveLength(8);
  });
});

describe("comingSoon", () => {
  it("marks no section: every section is live", () => {
    expect(
      allNavItems.filter((item) => item.comingSoon).map((item) => item.href),
    ).toEqual([]);
  });
});

describe("group", () => {
  it("puts the live sections in main and the placeholders in soon", () => {
    const hrefsOf = (group: string) =>
      allNavItems.filter((item) => item.group === group).map((item) => item.href);
    expect(hrefsOf("main")).toEqual([
      "/home",
      "/generate",
      "/question-bank",
      "/solve",
      "/materials",
      "/assessment-builder",
      "/trash",
      "/settings",
      "/more",
    ]);
    expect(hrefsOf("soon")).toEqual([]);
  });

  it("keeps the Segera chip and the soon group in step", () => {
    for (const item of allNavItems) {
      expect(item.group === "soon").toBe(item.comingSoon === true);
    }
  });
});

describe("mobileNavItems", () => {
  it("has exactly the 5 bottom-nav items in the spec's order", () => {
    expect(mobileNavItems.map((item) => item.href)).toEqual([
      "/home",
      "/generate",
      "/question-bank",
      "/solve",
      "/more",
    ]);
  });
});

describe("isNavItemActive", () => {
  it("matches the exact same path", () => {
    expect(isNavItemActive("/home", "/home")).toBe(true);
  });

  it("does not match a different top-level section", () => {
    expect(isNavItemActive("/question-bank", "/home")).toBe(false);
  });

  it("matches a nested route under the section's path", () => {
    expect(isNavItemActive("/generate/abc123", "/generate")).toBe(true);
  });

  it("does not match a different section that shares a text prefix", () => {
    expect(isNavItemActive("/generate-more", "/generate")).toBe(false);
  });
});
