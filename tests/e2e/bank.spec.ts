import { expect, test, type Page } from "@playwright/test";
import {
  DESKTOP,
  GENERATION_WAIT,
  NAVIGATION_TIMEOUT,
  PHONE,
  createRequest,
  expectNoAxeViolations,
  expectNoHorizontalScroll,
  fillDailyUsage,
  resetScenario,
  setScenario,
  waitForReviewReady,
  withViewport,
} from "./helpers";

// One question travels through the whole file: it is generated, approved and banked in the first
// test, then edited, filtered, restored, regenerated and trashed. The tests share it, so they run
// in order. The file is a generation spec (playwright.config.ts): it uses the fake user's one
// request slot and the scripted AI, and the daily budget is reset after every test.
const TOKEN = `jejak${String(Date.now())}`;
const UUID_PATH = /\/question-bank\/[0-9a-f-]{36}$/;

let questionPath = "";

// The card's link in the bank list.
function bankLink(page: Page) {
  return page.locator(`a[href="${questionPath}"]`);
}

// On a phone the facets live in a sheet opened by the "Filter" button; on a wide screen they are
// inline and the button is hidden.
async function openFilters(page: Page) {
  const open = page.getByRole("button", { name: /^Filter/ });
  if (await open.isVisible()) await open.click();
  await expect(page.getByLabel("Kelas", { exact: true })).toBeVisible();
}

async function applyFilters(
  page: Page,
  filters: { grade?: string; difficulty?: string },
) {
  await openFilters(page);
  if (filters.grade) {
    await page
      .getByLabel("Kelas", { exact: true })
      .selectOption({ label: filters.grade });
  }
  if (filters.difficulty) {
    await page
      .getByLabel("Tingkat kesulitan", { exact: true })
      .selectOption({ label: filters.difficulty });
  }
  await page.getByRole("button", { name: "Terapkan", exact: true }).click();
}

async function openRegenerateForm(page: Page) {
  await page.getByRole("button", { name: "Buat ulang", exact: true }).click();
  await expect(page.getByRole("form", { name: "Buat ulang soal ini" })).toBeVisible();
}

test.describe("question bank, editing and trash", () => {
  test.describe.configure({ mode: "serial" });

  test.afterEach(async ({ request }) => {
    await resetScenario(request);
  });

  test("a banked question is the starting point", async ({ page, request }) => {
    await resetScenario(request);
    await setScenario(request, "valid");
    await createRequest(page);
    await waitForReviewReady(page, 5);

    const first = page.getByRole("article", { name: "Soal 1", exact: true });
    await first.getByRole("button", { name: "Setujui", exact: true }).click();
    await expect(first.getByText("Disetujui", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Simpan ke Bank Soal" }).click();
    await expect(page.getByText("1 soal tersimpan", { exact: true })).toBeVisible();

    // Newest first: the question just banked is the first card.
    await page.goto("/question-bank");
    const href = await page
      .locator('a[href^="/question-bank/"]')
      .first()
      .getAttribute("href");
    expect(href).toMatch(UUID_PATH);
    questionPath = href ?? "";
  });

  test("edit and save: the history shows version 2", async ({ page }) => {
    await page.goto(`${questionPath}/edit`);
    await expect(page.getByRole("heading", { level: 1, name: "Ubah soal" })).toBeVisible({
      timeout: NAVIGATION_TIMEOUT,
    });
    // The explanation only: the stem, key and answer stay, so the checks and the bank place hold.
    await page
      .getByLabel("Pembahasan", { exact: true })
      .fill(`Jumlahkan kedua bilangan. ${TOKEN}`);
    await page.getByRole("button", { name: "Simpan versi baru" }).click();
    await expect(page).toHaveURL(UUID_PATH, { timeout: NAVIGATION_TIMEOUT });

    await page.goto(`${questionPath}/history`);
    const versions = page.getByRole("list", { name: "Daftar versi" });
    await expect(versions.getByRole("link", { name: /Versi 2/ })).toBeVisible({
      timeout: NAVIGATION_TIMEOUT,
    });
    await expect(versions.getByRole("link", { name: /Versi 1(?!\d)/ })).toBeVisible();
    await expect(versions.getByText("Versi saat ini")).toBeVisible();
  });

  test("filter by grade and difficulty, search, open the detail", async ({ page }) => {
    await page.goto("/question-bank");
    await expect(page.getByRole("heading", { level: 1, name: "Bank Soal" })).toBeVisible({
      timeout: NAVIGATION_TIMEOUT,
    });

    // Search: the token only exists in the edited explanation of our question.
    await page.getByRole("searchbox", { name: "Cari soal" }).fill(TOKEN);
    await page.getByRole("button", { name: "Cari", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`q=${TOKEN}`));
    await expect(page.locator('a[href^="/question-bank/"]')).toHaveCount(1);
    await expect(bankLink(page)).toBeVisible();

    // Grade and difficulty that the question has: still listed.
    await applyFilters(page, { grade: "Kelas 8", difficulty: "Sedang" });
    await expect(page).toHaveURL(/grade=8/);
    await expect(page).toHaveURL(/difficulty=sedang/);
    await expect(bankLink(page)).toBeVisible();

    // Another difficulty: nothing matches, with a way back.
    await applyFilters(page, { difficulty: "Sulit" });
    await expect(page).toHaveURL(/difficulty=sulit/);
    await expect(
      page.getByText("Tidak ada soal yang cocok", { exact: true }),
    ).toBeVisible();
    await expect(bankLink(page)).toHaveCount(0);
    await page.getByRole("link", { name: "Atur ulang filter" }).click();
    await expect(page).toHaveURL(/\/question-bank$/);

    // Open the detail from the list.
    await page.getByRole("searchbox", { name: "Cari soal" }).fill(TOKEN);
    await page.getByRole("button", { name: "Cari", exact: true }).click();
    await bankLink(page).click();
    await expect(page).toHaveURL(UUID_PATH, { timeout: NAVIGATION_TIMEOUT });
    await expect(
      page.getByRole("heading", { level: 1, name: "Detail soal" }),
    ).toBeVisible({
      timeout: NAVIGATION_TIMEOUT,
    });
    await expect(page.getByText(TOKEN)).toBeVisible();
  });

  test("restore version 1 from the history", async ({ page }) => {
    await page.goto(`${questionPath}/history`);
    const versions = page.getByRole("list", { name: "Daftar versi" });
    await versions.getByRole("link", { name: /Versi 1(?!\d)/ }).click();
    await expect(page).toHaveURL(/version=/, { timeout: NAVIGATION_TIMEOUT });
    await page.getByRole("button", { name: "Pulihkan versi ini" }).click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Versi dipulihkan sebagai versi baru." }),
    ).toBeVisible();
    // A restore adds version 3; versions 1 and 2 stay.
    await page.goto(`${questionPath}/history`);
    await expect(versions.getByRole("link", { name: /Versi 3/ })).toBeVisible();
    await expect(versions.getByRole("link", { name: /Versi 2/ })).toBeVisible();
    await expect(versions.getByRole("link", { name: /Versi 1(?!\d)/ })).toBeVisible();
  });

  test("regenerate with the fake provider, then keep the new version", async ({
    page,
  }) => {
    await page.goto(questionPath);
    await openRegenerateForm(page);
    await page.getByRole("button", { name: "Buat ulang soal", exact: true }).click();
    // The new version is checked, then shown next to the previous one.
    await expect(page.getByRole("heading", { name: "Bandingkan versi" })).toBeVisible({
      timeout: GENERATION_WAIT,
    });
    await page.getByRole("button", { name: "Pakai versi baru" }).click();
    await expect(page.getByRole("heading", { name: "Bandingkan versi" })).toHaveCount(0);

    await page.goto(`${questionPath}/history`);
    await expect(
      page.getByRole("list", { name: "Daftar versi" }).getByRole("link", {
        name: /Versi 4/,
      }),
    ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    await expect(page.getByText("Dibuat ulang").first()).toBeVisible();
  });

  test("regenerate counts toward the daily limit", async ({ page, request }) => {
    // The whole budget is used up (it is reset after this test), so one more question is refused.
    await fillDailyUsage(request);
    await page.goto(questionPath);
    await openRegenerateForm(page);
    await page.getByRole("button", { name: "Buat ulang soal", exact: true }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Batas harian 30 soal sudah tercapai." }),
    ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
  });

  test("axe is clean on the bank with filters, the editor and the history at 1280 and 390 px", async ({
    browser,
  }) => {
    const paths = [
      `/question-bank?grade=8&difficulty=sedang&q=${TOKEN}`,
      `/question-bank?grade=8&q=zzzzzzzz`,
      `${questionPath}/edit`,
      `${questionPath}/history`,
    ];
    for (const viewport of [DESKTOP, PHONE]) {
      await withViewport(browser, { viewport }, async (page) => {
        for (const path of paths) {
          const label = `${path} at ${String(viewport.width)} px`;
          await page.goto(path);
          await expect(page.locator("h1")).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
          await expectNoAxeViolations(page, label);
          if (viewport.width === PHONE.width) {
            await expectNoHorizontalScroll(page, label);
          }
        }
        if (viewport.width === PHONE.width) {
          // The filter sheet, open.
          await page.goto("/question-bank");
          await openFilters(page);
          await expectNoAxeViolations(page, "the open filter sheet at 390 px");
          await expectNoHorizontalScroll(page, "the open filter sheet at 390 px");
        }
      });
    }
  });

  test("axe is clean on the question editor after a refused save, which stays on the editor", async ({
    page,
  }) => {
    await page.goto(`${questionPath}/edit`);
    await expect(page.getByRole("heading", { level: 1, name: "Ubah soal" })).toBeVisible({
      timeout: NAVIGATION_TIMEOUT,
    });
    const stem = page.getByLabel("Teks soal", { exact: true });
    // Emptying the stem makes the form dirty (Save is enabled) and the client refuses it. A click
    // before React hydrates does not run the validation, so repeat it until the refusal shows.
    // Hydration also writes the saved text back into the field, and a fill that races it can leave
    // the stem cut short ("itung ..."): that is a valid edit, and Save would store it. So the click
    // waits until the stem really is empty.
    await expect(async () => {
      await stem.fill("");
      await expect(stem).toHaveValue("", { timeout: 1_000 });
      await page.getByRole("button", { name: "Simpan versi baru" }).click();
      await expect(stem).toHaveAttribute("aria-invalid", "true", { timeout: 2_000 });
    }).toPass({ timeout: NAVIGATION_TIMEOUT, intervals: [500, 1_000, 2_000] });
    await expect(
      page.getByRole("alert").filter({ hasText: "Periksa kolom yang ditandai." }),
    ).toBeVisible();
    await expectNoAxeViolations(page, "the question editor after a refused save");
    await expect(page).toHaveURL(/\/edit$/);
  });

  test("trash from the detail, then restore from /trash", async ({ page, browser }) => {
    await page.goto(questionPath);
    await page.getByRole("button", { name: /^Pindahkan ke Sampah/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Pindahkan soal ke Sampah?" }),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "Pindahkan ke Sampah", exact: true })
      .click();
    await expect(page).toHaveURL(/\/question-bank$/, { timeout: NAVIGATION_TIMEOUT });
    await expect(bankLink(page)).toHaveCount(0);

    // The trash lists it (newest deleted first) with the days left; axe and scroll are checked
    // with the item in place.
    await page.goto("/trash");
    await expect(page.getByRole("heading", { level: 1, name: "Sampah" })).toBeVisible({
      timeout: NAVIGATION_TIMEOUT,
    });
    const item = page
      .getByRole("list", { name: "Soal di Sampah" })
      .getByRole("listitem")
      .first();
    await expect(
      item.getByText(/30 hari lagi sebelum dihapus untuk selamanya/),
    ).toBeVisible();
    for (const viewport of [DESKTOP, PHONE]) {
      await withViewport(browser, { viewport }, async (narrow) => {
        await narrow.goto("/trash");
        await expect(narrow.locator("h1")).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
        const label = `/trash at ${String(viewport.width)} px`;
        await expectNoAxeViolations(narrow, label);
        if (viewport.width === PHONE.width) await expectNoHorizontalScroll(narrow, label);
      });
    }

    await item.getByRole("button", { name: /^Pulihkan soal:/ }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Soal dipulihkan ke tempat asalnya." }),
    ).toBeVisible();

    await page.goto("/question-bank");
    await expect(bankLink(page)).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
  });

  test("trash from a card, then delete permanently after the confirmation", async ({
    page,
  }) => {
    await page.goto("/question-bank");
    const card = page.getByRole("listitem").filter({ has: bankLink(page) });
    await card.getByRole("button", { name: /^Pindahkan ke Sampah/ }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Pindahkan ke Sampah", exact: true })
      .click();
    await expect(bankLink(page)).toHaveCount(0, { timeout: NAVIGATION_TIMEOUT });

    await page.goto("/trash");
    const item = page
      .getByRole("list", { name: "Soal di Sampah" })
      .getByRole("listitem")
      .first();
    await item.getByRole("button", { name: /^Hapus selamanya soal:/ }).click();

    // The confirmation says what goes; cancelling keeps the question.
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Hapus soal ini untuk selamanya?" }),
    ).toBeVisible();
    await expect(dialog.getByText(/Semua \d+ versi soal/)).toBeVisible();
    await expect(dialog.getByText("Semua hasil verifikasi setiap versi")).toBeVisible();
    await dialog.getByRole("button", { name: "Batal" }).click();
    await expect(dialog).toBeHidden();
    await expect(item).toBeVisible();

    await item.getByRole("button", { name: /^Hapus selamanya soal:/ }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Hapus selamanya", exact: true })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "Soal dihapus untuk selamanya." }),
    ).toBeVisible();

    // Gone for good: the detail, the history and the editor no longer exist.
    for (const path of [
      questionPath,
      `${questionPath}/history`,
      `${questionPath}/edit`,
    ]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
    }
  });
});
