import { expect, test, type Locator } from "@playwright/test";
import { signedInState } from "./auth";
import {
  DESKTOP,
  PHONE,
  expectNoAxeViolations,
  expectNoHorizontalScroll,
  withViewport,
} from "./helpers";

const ALL_ROUTES = [
  "/home",
  "/generate",
  "/question-bank",
  "/solve",
  "/more",
  "/materials",
  "/assessment-builder",
  "/trash",
  "/settings",
];

test.describe("App shell", () => {
  test("/ redirects to /home", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/home$/);
  });

  test("every section route renders its heading", async ({ page }) => {
    for (const route of ALL_ROUTES) {
      await page.goto(route);
      await expect(page.locator("h1")).toBeVisible();
    }
  });

  test("desktop: sidebar is visible with all 8 sections, bottom nav is hidden", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: signedInState(),
      viewport: { width: 1280, height: 800 },
      baseURL: "http://localhost:3000",
    });
    const page = await context.newPage();
    await page.goto("/home");

    await expect(
      page.getByRole("navigation", { name: /^Menu (utama|bawah)$/ }),
    ).toBeVisible();
    const sidebarLinks = page
      .getByRole("navigation", { name: /^Menu (utama|bawah)$/ })
      .getByRole("link");
    await expect(sidebarLinks).toHaveCount(8);
    await expect(
      page.getByRole("list", { name: "Menu utama" }).getByRole("link"),
    ).toHaveCount(8);
    // Every section is live (Selesaikan since the problem solver): no "Segera hadir" group.
    await expect(page.getByRole("list", { name: "Segera hadir" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Keluar" })).toBeVisible();
    await context.close();
  });

  test("mobile: bottom nav has exactly 5 items, no horizontal scroll", async ({
    browser,
  }) => {
    for (const width of [360, 375, 412]) {
      const context = await browser.newContext({
        storageState: signedInState(),
        viewport: { width, height: 800 },
        baseURL: "http://localhost:3000",
      });
      const page = await context.newPage();
      await page.goto("/home");

      const nav = page.getByRole("navigation", { name: /^Menu (utama|bawah)$/ });
      await expect(nav.getByRole("link")).toHaveCount(5);

      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(
        scrollWidth,
        `width=${String(width)}: content overflows horizontally`,
      ).toBeLessThanOrEqual(clientWidth + 1);
      await context.close();
    }
  });

  test("all nav links meet the 44x44px touch-target minimum", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/home");

    const links = page
      .getByRole("navigation", { name: /^Menu (utama|bawah)$/ })
      .getByRole("link");
    const count = await links.count();
    for (let i = 0; i < count; i += 1) {
      const box = await links.nth(i).boundingBox();
      expect(box, `link ${String(i)} has no bounding box`).not.toBeNull();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  for (const viewport of [DESKTOP, PHONE]) {
    test(`axe finds no violations on every shell route at ${String(viewport.width)} px`, async ({
      browser,
    }) => {
      // Each route compiles on its first request in the dev server.
      test.setTimeout(120_000);
      await withViewport(browser, { viewport }, async (page) => {
        for (const route of ALL_ROUTES) {
          await page.goto(route);
          await expect(page.locator("h1")).toBeVisible();
          await expectNoAxeViolations(page, `${route} at ${String(viewport.width)} px`);
        }
      });
    });
  }

  test("no horizontal scroll at 390 px on home, generate and question-bank", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    await withViewport(browser, { viewport: PHONE }, async (page) => {
      for (const route of ["/home", "/generate", "/question-bank"]) {
        await page.goto(route);
        await expect(page.locator("h1")).toBeVisible();
        await expectNoHorizontalScroll(page, route);
      }
    });
  });

  test("every nav link is reachable by keyboard alone", async ({ page }) => {
    await page.goto("/home");
    const links = page
      .getByRole("navigation", { name: /^Menu (utama|bawah)$/ })
      .getByRole("link");
    const expectedHrefs = await links.evaluateAll((els) =>
      els.map((el) => (el as HTMLAnchorElement).getAttribute("href")),
    );

    const reached = new Set<string>();
    for (let i = 0; i < expectedHrefs.length + 5; i += 1) {
      await page.keyboard.press("Tab");
      const href = await page.evaluate(
        () =>
          (document.activeElement as HTMLAnchorElement | null)?.getAttribute("href") ??
          null,
      );
      if (href) reached.add(href);
    }
    for (const href of expectedHrefs) {
      expect(
        reached.has(href ?? ""),
        `${href ?? "(no href)"} was not reachable by Tab`,
      ).toBe(true);
    }
  });

  // Describes every element under the links in `root` whose content is wider than its box (cut-off text).
  // One pixel of tolerance: scrollWidth and clientWidth are rounded separately.
  async function clippedLabels(root: Locator): Promise<string[]> {
    return root.evaluateAll((links) =>
      links
        .flatMap((link) => [link, ...Array.from(link.querySelectorAll("*"))])
        .filter(
          (el): el is HTMLElement =>
            el instanceof HTMLElement &&
            // Skip what is hidden on purpose (sr-only text is a 1 px clipped box).
            el.getBoundingClientRect().width > 1 &&
            el.getBoundingClientRect().height > 1 &&
            el.scrollWidth > el.clientWidth + 1,
        )
        .map((el) => `${el.tagName}: ${el.textContent}`),
    );
  }

  test("Indonesian locale: sidebar labels are not truncated", async ({ browser }) => {
    await withViewport(browser, { viewport: DESKTOP, locale: "id" }, async (page) => {
      await page.goto("/home");
      const sidebar = page.getByRole("navigation", { name: "Menu utama" });
      await expect(sidebar).toBeVisible();
      const links = sidebar.getByRole("link");
      await expect(links).toHaveCount(8);
      // The longest Indonesian labels sit next to the "Segera" chip in the 288 px sidebar.
      for (const label of ["Bank Soal", "Materi Pembelajaran", "Penyusun Asesmen"]) {
        await expect(
          sidebar.getByRole("link", { name: new RegExp(label) }),
        ).toBeVisible();
      }
      expect(await clippedLabels(links)).toEqual([]);
    });
  });

  test("English locale: sidebar labels are not truncated", async ({ browser }) => {
    await withViewport(browser, { viewport: DESKTOP, locale: "en" }, async (page) => {
      await page.goto("/home");
      const sidebar = page.getByRole("navigation", { name: "Main menu" });
      await expect(sidebar).toBeVisible();
      const links = sidebar.getByRole("link");
      await expect(links).toHaveCount(8);
      // The English catalog is active and the longest labels are all there.
      for (const label of ["Question bank", "Learning materials", "Assessment builder"]) {
        await expect(sidebar.getByRole("link", { name: label })).toBeVisible();
      }
      expect(await clippedLabels(links)).toEqual([]);
    });
  });

  for (const [locale, navName] of [
    ["id", "Menu bawah"],
    ["en", "Bottom menu"],
  ] as const) {
    test(`${locale} locale: bottom nav labels fit on one line at 390 px`, async ({
      browser,
    }) => {
      await withViewport(browser, { viewport: PHONE, locale }, async (page) => {
        await page.goto("/home");
        const nav = page.getByRole("navigation", { name: navName });
        await expect(nav).toBeVisible();
        const links = nav.getByRole("link");
        await expect(links).toHaveCount(5);
        expect(await clippedLabels(links)).toEqual([]);
        // Each visible label stays on one line: its box is no taller than one line of its text.
        const wrapped = await links.evaluateAll((els) =>
          els
            .flatMap((link) => Array.from(link.querySelectorAll("span")))
            .filter((span) => span.textContent.trim() !== "")
            .filter((span) => span.getBoundingClientRect().width > 1)
            .filter((span) => {
              const style = getComputedStyle(span);
              const line =
                parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
              return span.getBoundingClientRect().height > line * 1.2;
            })
            .map((span) => span.textContent),
        );
        expect(wrapped).toEqual([]);
        for (let i = 0; i < 5; i += 1) {
          const box = await links.nth(i).boundingBox();
          expect(box, `link ${String(i)} has no bounding box`).not.toBeNull();
          expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
          expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(PHONE.width);
        }
      });
    });
  }
});
