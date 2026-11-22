import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  E2E_ALTERNATIVE_METHOD,
  E2E_METHOD,
} from "../../src/lib/ai/e2e/material-scripts";
import {
  DESKTOP,
  GENERATION_WAIT,
  NAVIGATION_TIMEOUT,
  PHONE,
  T,
  expectNoAxeViolations,
  expectNoHorizontalScroll,
  resetAiAndDailyUsage,
  resetScenario,
  withViewport,
} from "./helpers";
import { scannedPagePng } from "./material-files";

// The problem solver with the scripted AI: a typed problem is solved and verified automatically
// (a claim recomputes the answer from the problem's numbers and the independent cross-check
// agrees, R26), "show another method" adds a second method, and a photo whose reading has an
// uncertain part must be confirmed before anything is solved (SOL-02). The scripted vision answer
// for every photo is "Hitung [[?]]$12 + 30$[[?]]." (src/lib/ai/e2e/material-scripts.ts). The
// tests share the sessions, so they run in order. The file is a generation spec: it uses the
// scripted AI. resetScenario deletes the fake user's sessions and gives back the day's solves, so
// it runs before and after the file only.
const TYPED = "Hitung $17 + 25$.";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SESSION_PATH = new RegExp(`/solve/${UUID}$`);

let typedPath = "";
let photoPath = "";

function status(scope: Page | Locator, text: string | RegExp) {
  return scope.getByRole("status").filter({ hasText: text });
}

function solution(page: Page, number: number, method: string) {
  return page.getByRole("article").filter({
    has: page.getByRole("heading", { name: `Metode ${String(number)}: ${method}` }),
  });
}

// Every solution card's heading ("Metode 1: ...").
function solutions(page: Page) {
  return page.getByRole("heading", { name: /^Metode \d+: / });
}

async function openSolve(page: Page) {
  await page.goto("/solve");
  await expect(
    page.getByRole("heading", { level: 1, name: "Selesaikan soal" }),
  ).toBeVisible({
    timeout: NAVIGATION_TIMEOUT,
  });
}

function recent(page: Page) {
  return page.getByRole("list", { name: "Soal terbaru" });
}

test.describe("problem solver", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ request }) => {
    await resetScenario(request);
  });

  test.afterEach(async ({ request }) => {
    await resetAiAndDailyUsage(request);
  });

  test.afterAll(async ({ request }) => {
    await resetScenario(request);
  });

  test("solve a typed problem: steps, final answer and the verification badge", async ({
    page,
  }) => {
    await openSolve(page);
    await expect(
      page.getByText("30 dari 30 penyelesaian tersisa hari ini", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Belum ada soal yang diselesaikan.", { exact: true }),
    ).toBeVisible();

    await page.getByLabel("Teks soal", { exact: true }).fill(TYPED);
    await page.getByRole("button", { name: "Selesaikan dan periksa" }).click();
    await page.waitForURL(SESSION_PATH, { timeout: GENERATION_WAIT });
    typedPath = new URL(page.url()).pathname;

    // The job (solve and the independent cross-check) runs after the action; the page follows it.
    const first = solution(page, 1, E2E_METHOD);
    await expect(first).toBeVisible({ timeout: GENERATION_WAIT });
    await expect(first.getByText(T.verified, { exact: true })).toBeVisible({
      timeout: GENERATION_WAIT,
    });
    await expect(first.getByText("Jawaban akhir", { exact: true })).toBeVisible();
    await expect(first.getByText("42").first()).toBeVisible();
    await expect(
      first.getByText("Langkah penyelesaian (1)", { exact: true }),
    ).toBeVisible();
  });

  test("show another method: a second, different method", async ({ page }) => {
    await page.goto(typedPath);
    await page
      .getByRole("button", { name: "Tampilkan metode lain" })
      .click({ timeout: NAVIGATION_TIMEOUT });
    const second = solution(page, 2, E2E_ALTERNATIVE_METHOD);
    await expect(second).toBeVisible({ timeout: GENERATION_WAIT });
    await expect(second.getByText("Metode lain", { exact: true })).toBeVisible();
    await expect(solution(page, 1, E2E_METHOD)).toBeVisible();
  });

  test("the recent list shows the session; each run counted toward the daily solves", async ({
    page,
  }) => {
    await openSolve(page);
    const item = recent(page).locator(`a[href="${typedPath}"]`);
    await expect(item).toBeVisible();
    await expect(item.getByText("Selesai", { exact: true })).toBeVisible();
    await expect(item.getByText("Diketik", { exact: true })).toBeVisible();
    // The solve and the second method; the cross-checks are part of their runs.
    await expect(
      page.getByText("28 dari 30 penyelesaian tersisa hari ini", { exact: true }),
    ).toBeVisible();
  });

  test("a photo with an uncertain reading waits for the teacher's confirmation", async ({
    page,
    browser,
  }) => {
    await openSolve(page);
    await page.getByRole("tab", { name: "Foto atau gambar" }).click();
    await page.getByLabel("Pilih gambar", { exact: true }).setInputFiles({
      name: "soal-foto.png",
      mimeType: "image/png",
      buffer: scannedPagePng(),
    });
    await expect(page.getByText("Dipilih: soal-foto.png", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Baca soal dari foto" }).click();
    await page.waitForURL(SESSION_PATH, { timeout: GENERATION_WAIT });
    photoPath = new URL(page.url()).pathname;

    // The reading has an uncertain part: the confirmation step, and no solution yet.
    await expect(
      page.getByRole("heading", { name: "Periksa hasil bacaan foto" }),
    ).toBeVisible({ timeout: GENERATION_WAIT });
    await expect(
      page.getByText("Belum pasti terbaca: $12 + 30$", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("img", { name: "Foto soal" })).toBeVisible();
    await expect(solutions(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Selesaikan lagi" })).toHaveCount(0);

    // Solving is refused while a [[?]] marker is left.
    await page.getByRole("button", { name: "Konfirmasi dan selesaikan" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Masih ada bagian bertanda [[?]]." }),
    ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    await expect(solutions(page)).toHaveCount(0);

    // axe and scroll on the confirmation step.
    for (const viewport of [DESKTOP, PHONE]) {
      await withViewport(browser, { viewport }, async (narrow) => {
        const label = `${photoPath} (confirmation) at ${String(viewport.width)} px`;
        await narrow.goto(photoPath);
        await expect(
          narrow.getByRole("heading", { name: "Periksa hasil bacaan foto" }),
        ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
        await expectNoAxeViolations(narrow, label);
        if (viewport.width === PHONE.width) await expectNoHorizontalScroll(narrow, label);
      });
    }

    // Corrected and confirmed: now it is solved and verified.
    await page.getByLabel("Teks soal", { exact: true }).fill("Hitung $12 + 30$.");
    await page.getByRole("button", { name: "Konfirmasi dan selesaikan" }).click();
    const first = solution(page, 1, E2E_METHOD);
    await expect(first).toBeVisible({ timeout: GENERATION_WAIT });
    await expect(first.getByText(T.verified, { exact: true })).toBeVisible({
      timeout: GENERATION_WAIT,
    });
    await expect(
      page.getByRole("heading", { name: "Periksa hasil bacaan foto" }),
    ).toHaveCount(0);
  });

  test("axe is clean on /solve and a solved session at 1280 and 390 px", async ({
    browser,
  }) => {
    for (const viewport of [DESKTOP, PHONE]) {
      await withViewport(browser, { viewport }, async (page) => {
        for (const path of ["/solve", typedPath]) {
          const label = `${path} at ${String(viewport.width)} px`;
          await page.goto(path);
          await expect(page.locator("h1")).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
          await expectNoAxeViolations(page, label);
          if (viewport.width === PHONE.width) {
            await expectNoHorizontalScroll(page, label);
          }
        }
      });
    }
  });

  test("trash a session: it leaves the recent list and waits in /trash", async ({
    page,
    browser,
  }) => {
    await page.goto(photoPath);
    await page
      .getByRole("button", { name: "Pindahkan soal ini ke Sampah" })
      .click({ timeout: NAVIGATION_TIMEOUT });
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Pindahkan soal ke Sampah?" }),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "Pindahkan ke Sampah", exact: true })
      .click();
    await expect(page).toHaveURL(/\/solve$/, { timeout: NAVIGATION_TIMEOUT });
    await expect(recent(page).locator(`a[href="${photoPath}"]`)).toHaveCount(0);
    await expect(recent(page).locator(`a[href="${typedPath}"]`)).toBeVisible();

    await page.goto("/trash");
    const trashed = page
      .getByRole("list", { name: "Soal yang diselesaikan di Sampah" })
      .getByRole("listitem");
    await expect(trashed).toHaveCount(1, { timeout: NAVIGATION_TIMEOUT });
    await expect(
      trashed.getByText(/30 hari lagi sebelum dihapus untuk selamanya/),
    ).toBeVisible();
    for (const viewport of [DESKTOP, PHONE]) {
      await withViewport(browser, { viewport }, async (narrow) => {
        await narrow.goto("/trash");
        await expect(narrow.locator("h1")).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
        const label = `/trash with a solver session at ${String(viewport.width)} px`;
        await expectNoAxeViolations(narrow, label);
        if (viewport.width === PHONE.width) await expectNoHorizontalScroll(narrow, label);
      });
    }

    // Restored, it is back in the recent list.
    await trashed.getByRole("button", { name: /^Pulihkan soal:/ }).click();
    await expect(status(page, "Soal dipulihkan.")).toBeVisible();
    await openSolve(page);
    await expect(recent(page).locator(`a[href="${photoPath}"]`)).toBeVisible();
  });
});
