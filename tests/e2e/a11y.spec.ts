import { expect, test, type Locator } from "@playwright/test";
import { signedInState } from "./auth";
import {
  DESKTOP,
  NAVIGATION_TIMEOUT,
  PHONE,
  T,
  createRequest,
  expectNoAxeViolations,
  expectNoHorizontalScroll,
  questionCards,
  resetScenario,
  setScenario,
  waitForReviewReady,
  withViewport,
} from "./helpers";

// Clicks `submit` until `refusal` shows. A click before React hydrates does not run the form's
// client validation, so the click is repeated until it does (the form then shows the refusal).
async function submitUntil(submit: Locator, refusal: () => Promise<void>) {
  await expect(async () => {
    await submit.click();
    await refusal();
  }).toPass({ timeout: NAVIGATION_TIMEOUT, intervals: [500, 1_000, 2_000] });
}

test.describe("accessibility after a failed submit", () => {
  test("axe is clean on /generate after a submit without a topic", async ({ page }) => {
    await page.goto("/generate");
    const form = page.getByRole("main");
    await submitUntil(form.getByRole("button", { name: T.submit, exact: true }), () =>
      expect(form.getByText("Pilih satu topik terlebih dahulu.").first()).toBeVisible({
        timeout: 2_000,
      }),
    );
    await expectNoAxeViolations(page, "/generate after a failed submit");
  });

  test("axe is clean on the templates card in Settings after a submit without a name", async ({
    page,
  }) => {
    await page.goto("/settings");
    const card = page.getByRole("region", { name: "Templat dokumen" });
    await expect(card).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    // The "new template" form, whatever templates already exist (an edit form may sit above it).
    const form = card
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Templat baru" }) });
    await submitUntil(form.getByRole("button", { name: "Simpan templat" }), () =>
      expect(form.getByLabel("Nama templat", { exact: true })).toHaveAttribute(
        "aria-invalid",
        "true",
        { timeout: 2_000 },
      ),
    );
    await expectNoAxeViolations(page, "/settings templates card after a failed submit");
  });
});

test.describe("accessibility with real data", () => {
  test.describe.configure({ mode: "serial" });

  // Set by the first test; the later ones (skipped if it fails) open the same populated page.
  let requestPath = "";

  test("axe is clean on Beranda, Buat Soal, a populated request page and Bank Soal; no horizontal scroll on the request page", async ({
    page,
    request,
    browser,
  }) => {
    await resetScenario(request);
    await setScenario(request, "valid");
    const requestId = await createRequest(page);
    await waitForReviewReady(page, 5);
    requestPath = `/generate/${requestId}`;

    // The populated request page (the page is still on it).
    await expectNoAxeViolations(page, requestPath);

    for (const path of [
      "/home",
      "/generate",
      "/question-bank",
      "/question-bank?grade=8&q=zzzzzzzz",
    ]) {
      await page.goto(path);
      await expect(page.locator("h1")).toBeVisible();
      await expectNoAxeViolations(page, path);
    }

    for (const width of [360, 375, 412]) {
      const context = await browser.newContext({
        storageState: signedInState(),
        viewport: { width, height: 800 },
        baseURL: "http://localhost:3000",
      });
      const narrow = await context.newPage();
      await narrow.goto(requestPath);
      await waitForReviewReady(narrow, 5);
      const { scrollWidth, clientWidth } = await narrow.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth, `width=${String(width)}`).toBeLessThanOrEqual(clientWidth + 1);
      await context.close();
    }
  });

  test("axe finds no violations on the review page at 1280 px and 390 px", async ({
    browser,
  }) => {
    for (const viewport of [DESKTOP, PHONE]) {
      await withViewport(browser, { viewport }, async (page) => {
        await page.goto(requestPath);
        await waitForReviewReady(page, 5);
        await expectNoAxeViolations(
          page,
          `${requestPath} at ${String(viewport.width)} px`,
        );
      });
    }
  });

  test("no horizontal scroll at 390 px on the review page", async ({ browser }) => {
    await withViewport(browser, { viewport: PHONE }, async (page) => {
      await page.goto(requestPath);
      await waitForReviewReady(page, 5);
      await expectNoHorizontalScroll(page, requestPath);
    });
  });

  test("review page: the save bar does not intersect the last question card at 390 px", async ({
    browser,
  }) => {
    await withViewport(browser, { viewport: PHONE }, async (page) => {
      await page.goto(requestPath);
      await waitForReviewReady(page, 5);

      // The save bar is the sticky box around the save button; the bottom nav is fixed to the
      // viewport, so everything is measured in viewport coordinates after scrolling to the end.
      const saveBar = page
        .locator("div.sticky")
        .filter({ has: page.getByRole("button", { name: "Simpan ke Bank Soal" }) });
      const bottomNav = page.getByRole("navigation", { name: "Menu bawah" });
      await page.evaluate(() => {
        window.scrollTo(0, document.documentElement.scrollHeight);
      });
      await expect(saveBar).toBeInViewport();

      const bar = await saveBar.boundingBox();
      const card = await questionCards(page).last().boundingBox();
      const nav = await bottomNav.boundingBox();
      expect(bar, "save bar has no bounding box").not.toBeNull();
      expect(card, "last question card has no bounding box").not.toBeNull();
      expect(nav, "bottom nav has no bounding box").not.toBeNull();
      if (!bar || !card || !nav) return;

      // The bar sits below the last card (no vertical overlap) and above the fixed bottom nav.
      expect(bar.y, "save bar starts below the last card").toBeGreaterThanOrEqual(
        card.y + card.height - 0.5,
      );
      expect(
        bar.y + bar.height,
        "save bar ends above the bottom nav",
      ).toBeLessThanOrEqual(nav.y + 0.5);
      // And the last card is not hidden under the bottom nav either.
      expect(card.y + card.height).toBeLessThanOrEqual(nav.y + 0.5);
    });
  });
});
