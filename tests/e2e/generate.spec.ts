import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signedInState } from "./auth";

test.describe("Buat Soal topic picker", () => {
  test("renders the heading and the grade selector with Grades 7 and 9 disabled", async ({
    page,
  }) => {
    await page.goto("/generate");
    await expect(page.locator("h1")).toHaveText("Buat Soal");
    await expect(page.getByRole("group", { name: "Kelas" })).toBeVisible();
    await expect(page.getByRole("radio", { name: /Kelas 8/ })).toBeChecked();
    await expect(page.getByRole("radio", { name: /Kelas 7/ })).toBeDisabled();
    await expect(page.getByRole("radio", { name: /Kelas 9/ })).toBeDisabled();
  });

  // Locally the dev server reads .env.local, so the list may load; otherwise the unavailable
  // message shows. Either is acceptable here.
  test("shows either the topic list or the unavailable message", async ({ page }) => {
    await page.goto("/generate");
    const list = page.getByRole("searchbox", { name: "Cari topik" });
    const notice = page.getByText(/Daftar topik belum/);
    await expect(list.or(notice).first()).toBeVisible();
  });

  test("has no horizontal scroll on phone widths", async ({ browser }) => {
    for (const width of [360, 375, 412]) {
      const context = await browser.newContext({
        storageState: signedInState(),
        viewport: { width, height: 800 },
        baseURL: "http://localhost:3000",
      });
      const page = await context.newPage();
      await page.goto("/generate");
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth, `width=${String(width)}`).toBeLessThanOrEqual(clientWidth + 1);
      await context.close();
    }
  });

  test("axe WCAG 2.2 AA scan is clean", async ({ page }) => {
    await page.goto("/generate");
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test("shows the generation form controls when the catalogue is available", async ({
    page,
  }) => {
    await page.goto("/generate");
    const search = page.getByRole("searchbox", { name: "Cari topik" });
    if (!(await search.isVisible()))
      test.skip(true, "catalogue not available in this environment");
    await expect(page.getByRole("group", { name: "Jumlah soal" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Tingkat kesulitan" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "5" })).toBeChecked();
    await expect(page.getByRole("radio", { name: "Sedang" })).toBeChecked();
    await expect(page.getByRole("button", { name: "Buat soal" })).toBeVisible();
  });

  test("shows the not-found page for an unknown or malformed request id", async ({
    page,
  }) => {
    for (const id of ["not-a-uuid", "6f1b1d0e-3c52-4a0b-9d34-2f6a3b1c7e55"]) {
      await page.goto(`/generate/${id}`);
      await expect(page.getByText("This page could not be found.")).toBeVisible();
    }
  });
});
