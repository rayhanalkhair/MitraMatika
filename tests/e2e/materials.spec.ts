import { expect, test, type Locator, type Page } from "@playwright/test";
import { E2E_OCR_MARKDOWN } from "../../src/lib/ai/e2e/material-scripts";
import {
  DESKTOP,
  GENERATION_WAIT,
  NAVIGATION_TIMEOUT,
  PHONE,
  T,
  expectNoAxeViolations,
  expectNoHorizontalScroll,
  pickTopic,
  reloadUntil,
  resetAiAndDailyUsage,
  resetScenario,
  setScenario,
  waitForReviewReady,
  withViewport,
} from "./helpers";
import { SEARCH_WORD, scannedPagePng, textPdf } from "./material-files";

// One text PDF travels through the whole file: it is uploaded through the real UI (signed PUT to
// the dev upload route, then the finalise route), read by the ingestion job in the dev server,
// searched, filed in a folder, trashed and restored, used to generate cited questions (one is
// banked), and finally deleted for good while the banked question keeps its content (MAT-11).
// A PNG stands in for a scanned page for OCR: the server never renders PDF pages, and pdf.js in
// headless Chromium is not what this spec checks (the review page still loads the PDF viewer for
// axe). The tests share these materials, so they run in order. The file is a generation spec
// (playwright.config.ts): it uses the fake user's request slot and the scripted AI. resetScenario
// deletes the fake user's materials, so it runs before and after the file only.
const PDF_NAME = "Buku SPLDV e2e.pdf";
const TITLE = "Buku SPLDV e2e";
const SCAN_NAME = "Halaman pindaian e2e.png";
const SCAN_TITLE = "Halaman pindaian e2e";
const FOLDER = "Bab aljabar e2e";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const MATERIAL_PATH = new RegExp(`/materials/${UUID}$`);
const REQUEST_URL = new RegExp(`/generate/${UUID}$`);
const BANK_PATH = new RegExp(`^/question-bank/${UUID}$`);

let materialPath = "";
let scanPath = "";
let bankPath = "";

function status(scope: Page | Locator, text: string | RegExp) {
  return scope.getByRole("status").filter({ hasText: text });
}

function materialCard(page: Page, title: string) {
  return page
    .getByRole("list", { name: "Daftar materi" })
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: title, exact: true }) });
}

async function openLibrary(page: Page, path = "/materials") {
  await page.goto(path);
  await expect(
    page.getByRole("heading", { level: 1, name: "Materi Pembelajaran" }),
  ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
}

/** Uploads through the dropzone, then waits for the material to be read. Returns its path. */
async function upload(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
  title: string,
  readStatus: string,
): Promise<string> {
  await openLibrary(page);
  await page.getByLabel("Pilih berkas", { exact: true }).setInputFiles(file);
  await expect(status(page, `${file.name} tersimpan. Teks sedang dibaca.`)).toBeVisible({
    timeout: GENERATION_WAIT,
  });
  // The ingestion job runs after the finalise response; the list does not poll.
  await reloadUntil(page, async () => {
    await expect(materialCard(page, title).getByText(readStatus)).toBeVisible({
      timeout: 2_000,
    });
  });
  const href = await materialCard(page, title)
    .getByRole("link", { name: title, exact: true })
    .getAttribute("href");
  expect(href).toMatch(MATERIAL_PATH);
  return href ?? "";
}

async function openMaterial(page: Page, path: string, title: string) {
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible({
    timeout: NAVIGATION_TIMEOUT,
  });
}

async function confirmMoveToTrash(page: Page) {
  await page.getByRole("button", { name: `Pindahkan ke Sampah: ${TITLE}` }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Pindahkan materi ke Sampah?" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Pindahkan ke Sampah", exact: true }).click();
  await expect(page).toHaveURL(/\/materials$/, { timeout: NAVIGATION_TIMEOUT });
}

function trashedMaterial(page: Page) {
  return page
    .getByRole("list", { name: "Materi di Sampah" })
    .getByRole("listitem")
    .filter({ hasText: TITLE });
}

/**
 * Picks a radio drawn as a button: the input is a 1 px "sr-only" box, so Playwright's own click on it
 * lands on whatever sits beside that box and never succeeds. A person clicks the label, so does this.
 */
async function chooseRadio(page: Page, name: string) {
  await page
    .locator("label")
    .filter({ hasText: new RegExp("^" + name + "$") })
    .click();
  await expect(page.getByRole("radio", { name, exact: true })).toBeChecked();
}

/**
 * The card of the scripted question "n + n" (the fake AI writes question n as n + n and cites the
 * offered passages in turn, so question n cites the (n-1) mod 2-th of P2, P3). The cards are NOT
 * in the order the questions were written: a batch shares one created_at and the list breaks the
 * tie by a random id, so "Soal 1" is any of them.
 */
function questionCard(page: Page, n: number) {
  const sum = new RegExp(String(n) + /\s*\+\s*/.source + String(n));
  return page.getByRole("article").filter({ hasText: sum });
}

/** On /generate: topic SPLDV, source "Dari materi", the PDF, pages 2-3; then submits. */
async function generateFromPages(page: Page) {
  await page.goto("/generate");
  // Picking the topic first also waits for hydration (the source choice is client state).
  await pickTopic(page);
  await chooseRadio(page, "Dari materi");
  await page
    .getByRole("combobox", { name: "Materi", exact: true })
    .selectOption({ label: TITLE });
  await chooseRadio(page, "Halaman");
  await page.getByRole("textbox", { name: "Halaman", exact: true }).fill("2-3");
  await page.getByRole("button", { name: T.submit, exact: true }).click();
  await page.waitForURL(REQUEST_URL, { timeout: GENERATION_WAIT });
}

test.describe("learning materials, OCR and cited generation", () => {
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

  test("upload a text PDF: it is stored, read page by page and counted in storage", async ({
    page,
  }) => {
    await openLibrary(page);
    await expect(page.getByText("Belum ada materi.", { exact: true })).toBeVisible();
    materialPath = await upload(
      page,
      { name: PDF_NAME, mimeType: "application/pdf", buffer: textPdf() },
      TITLE,
      "Siap dipakai",
    );
    const card = materialCard(page, TITLE);
    await expect(card.getByText("3 halaman", { exact: true })).toBeVisible();
    await expect(card.getByText("PDF", { exact: true })).toBeVisible();
    // The meter counts the stored file against the 300 MB cap.
    await expect(page.getByRole("meter", { name: "Penyimpanan" })).toBeVisible();
    await expect(page.getByText(/dari 300 MB terpakai$/)).toBeVisible();
  });

  test("the detail shows the file, its text quality and each page's text", async ({
    page,
  }) => {
    await openMaterial(page, materialPath, TITLE);
    await expect(page.getByText("Siap dipakai").first()).toBeVisible();
    await expect(
      page.getByText("3 halaman jelas, 0 perlu diperiksa, 0 sulit dibaca", {
        exact: true,
      }),
    ).toBeVisible();
    // Every page is clear: nothing to OCR.
    await expect(
      page.getByText("Tidak ada halaman yang bisa di-OCR.", { exact: true }),
    ).toBeVisible();

    await page.goto(`${materialPath}?page=2`);
    await expect(page.getByText("Halaman 2 dari 3", { exact: true })).toBeVisible({
      timeout: NAVIGATION_TIMEOUT,
    });
    await expect(page.getByLabel("Teks halaman 2", { exact: true })).toHaveValue(
      /Sistem persamaan linear dua variabel/,
    );
    await expect(page.getByText("Teks dari PDF", { exact: true })).toBeVisible();
    await expect(page.getByText("Teks jelas", { exact: true })).toBeVisible();
  });

  test("search finds the page; a folder holds the material", async ({ page }) => {
    await openLibrary(page);
    // Search covers the page text: the word is only on page 3.
    await page.getByRole("searchbox", { name: "Cari materi" }).fill(SEARCH_WORD);
    await page.getByRole("button", { name: "Terapkan", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`q=${SEARCH_WORD}`));
    await expect(
      materialCard(page, TITLE).getByText("Ditemukan di hal. 3", { exact: true }),
    ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    await page.getByRole("searchbox", { name: "Cari materi" }).fill("tidakadasamasekali");
    await page.getByRole("button", { name: "Terapkan", exact: true }).click();
    await expect(
      page.getByText("Tidak ada materi yang cocok.", { exact: true }),
    ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });

    // A new top-level folder.
    await openLibrary(page);
    await page.getByLabel("Nama folder", { exact: true }).fill(FOLDER);
    await page.getByRole("button", { name: "Buat folder", exact: true }).click();
    await expect(status(page, "Folder dibuat.")).toBeVisible({
      timeout: NAVIGATION_TIMEOUT,
    });
    const folderLink = page
      .getByRole("navigation", { name: "Folder materi" })
      .getByRole("link", { name: new RegExp(FOLDER) });
    await expect(folderLink).toBeVisible();

    // The material moves into it from its detail page.
    await openMaterial(page, materialPath, TITLE);
    await page
      .getByLabel("Pindahkan ke folder", { exact: true })
      .selectOption({ label: FOLDER });
    await page.getByRole("button", { name: "Pindahkan", exact: true }).click();
    await expect(status(page, "Materi dipindahkan.")).toBeVisible({
      timeout: NAVIGATION_TIMEOUT,
    });

    // The folder link filters the list to it.
    await openLibrary(page);
    await expect(
      materialCard(page, TITLE).getByText(`Folder: ${FOLDER}`, { exact: true }),
    ).toBeVisible();
    await folderLink.click();
    await expect(page).toHaveURL(/folder=/, { timeout: NAVIGATION_TIMEOUT });
    await expect(materialCard(page, TITLE)).toBeVisible();
    await expect(folderLink).toHaveAttribute("aria-current", "page");
  });

  test("trash a material, see it in /trash (axe at 1280 and 390 px), restore it", async ({
    page,
    browser,
  }) => {
    await openMaterial(page, materialPath, TITLE);
    await confirmMoveToTrash(page);
    await expect(materialCard(page, TITLE)).toHaveCount(0);

    await page.goto("/trash");
    await expect(page.getByRole("heading", { level: 1, name: "Sampah" })).toBeVisible({
      timeout: NAVIGATION_TIMEOUT,
    });
    await expect(
      trashedMaterial(page).getByText(/30 hari lagi sebelum dihapus untuk selamanya/),
    ).toBeVisible();
    for (const viewport of [DESKTOP, PHONE]) {
      await withViewport(browser, { viewport }, async (narrow) => {
        await narrow.goto("/trash");
        await expect(narrow.locator("h1")).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
        const label = `/trash with a material at ${String(viewport.width)} px`;
        await expectNoAxeViolations(narrow, label);
        if (viewport.width === PHONE.width) await expectNoHorizontalScroll(narrow, label);
      });
    }

    await trashedMaterial(page)
      .getByRole("button", { name: `Pulihkan materi: ${TITLE}` })
      .click();
    await expect(status(page, "Materi dipulihkan.")).toBeVisible();
    await openLibrary(page);
    await expect(materialCard(page, TITLE).getByText("Siap dipakai")).toBeVisible();
  });

  test("generate from pages 2-3: each question cites its page, also in the bank", async ({
    page,
    request,
  }) => {
    await setScenario(request, "valid");
    await generateFromPages(page);
    await waitForReviewReady(page, 5);

    // The scripted answer cites the offered passages in turn: P2, P3, P2, ...
    const first = questionCard(page, 1);
    await expect(first.getByText(`Sumber: ${TITLE}, hal. 2`)).toBeVisible();
    await expect(
      questionCard(page, 2).getByText(`Sumber: ${TITLE}, hal. 3`),
    ).toBeVisible();
    await expect(first.getByText(T.verified, { exact: true })).toBeVisible();

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
    expect(href).toMatch(BANK_PATH);
    bankPath = href ?? "";
    await page.goto(bankPath);
    await expect(page.getByText(`Sumber: ${TITLE}, hal. 2`)).toBeVisible({
      timeout: NAVIGATION_TIMEOUT,
    });
  });

  test("an invented citation is rejected: the question cannot be verified", async ({
    page,
    request,
  }) => {
    // Question 1 cites [P99], a passage the prompt never offered, and so does its replacement.
    await setScenario(request, "invented_citation");
    await generateFromPages(page);
    await waitForReviewReady(page, 5);

    const first = questionCard(page, 1);
    await expect(
      first.getByText("Belum dapat diverifikasi", { exact: true }),
    ).toBeVisible();
    await expect(first.getByText(/^Sumber:/)).toHaveCount(0);
    await expect(
      questionCard(page, 2).getByText(`Sumber: ${TITLE}, hal. 3`),
    ).toBeVisible();
  });

  test("OCR a scanned page: the daily count, the result and the review", async ({
    page,
  }) => {
    scanPath = await upload(
      page,
      { name: SCAN_NAME, mimeType: "image/png", buffer: scannedPagePng() },
      SCAN_TITLE,
      "Perlu ditinjau",
    );
    await openMaterial(page, scanPath, SCAN_TITLE);
    const selector = page.getByRole("region", { name: "OCR halaman", exact: true });
    await expect(
      selector.getByText("20 dari 20 halaman tersisa hari ini", { exact: true }),
    ).toBeVisible();
    await selector.getByRole("checkbox", { name: "Halaman 1" }).check();
    await selector.getByRole("button", { name: "OCR halaman terpilih" }).click();
    await expect(status(selector, "1 halaman masuk antrean OCR.")).toBeVisible({
      timeout: NAVIGATION_TIMEOUT,
    });
    await expect(
      selector.getByText("19 dari 20 halaman tersisa hari ini", { exact: true }),
    ).toBeVisible();

    // The OCR job runs after the action's response (no real pacing wait in e2e); the page does
    // not poll.
    await reloadUntil(page, async () => {
      await expect(page.getByText("Sudah di-OCR", { exact: true })).toBeVisible({
        timeout: 2_000,
      });
    });
    const text = page.getByLabel("Teks halaman 1", { exact: true });
    await expect(text).toHaveValue(/Sistem persamaan linear dua variabel/);
    await expect(page.getByText("Hasil OCR", { exact: true })).toBeVisible();
    await expect(
      page.getByText("1 bagian bertanda [[?]].", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("19 dari 20 halaman tersisa hari ini", { exact: true }),
    ).toBeVisible();

    // The teacher corrects the uncertain part and saves the page as their own text.
    await text.fill(E2E_OCR_MARKDOWN.replaceAll("[[?]]", ""));
    await expect(
      page.getByText("Tidak ada bagian bertanda [[?]].", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Simpan teks", exact: true }).click();
    await expect(status(page, "Teks halaman disimpan.")).toBeVisible({
      timeout: NAVIGATION_TIMEOUT,
    });
    await page.reload();
    await expect(page.getByText("Diperbaiki guru", { exact: true })).toBeVisible({
      timeout: NAVIGATION_TIMEOUT,
    });
  });

  test("axe is clean on the library, a detail and the OCR review at 1280 and 390 px", async ({
    browser,
  }) => {
    const paths = [
      "/materials",
      `/materials?q=${SEARCH_WORD}`,
      materialPath,
      `${materialPath}?page=2`,
      `${scanPath}?page=1`,
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
      });
    }
  });

  test("axe is clean on the structure editor after a refused save", async ({ page }) => {
    await openMaterial(page, materialPath, TITLE);
    const editor = page.getByRole("region", { name: "Struktur materi" });
    const title = editor.getByLabel("Judul", { exact: true });
    // An empty title is refused by the client schema. A click before React hydrates does not run
    // it, so repeat the click until the refusal shows.
    await expect(async () => {
      await title.fill("");
      // A fill that races hydration can leave a cut title, which is a valid save: click on empty.
      await expect(title).toHaveValue("", { timeout: 1_000 });
      await editor.getByRole("button", { name: "Simpan struktur" }).click();
      await expect(title).toHaveAttribute("aria-invalid", "true", { timeout: 2_000 });
    }).toPass({ timeout: NAVIGATION_TIMEOUT, intervals: [500, 1_000, 2_000] });
    await expect(editor.getByText("Isi judul, paling banyak 200 huruf.")).toBeVisible();
    await expectNoAxeViolations(page, "the structure editor after a refused save");
  });

  test("delete the material for good: the banked question says its source is gone", async ({
    page,
  }) => {
    await openMaterial(page, materialPath, TITLE);
    await confirmMoveToTrash(page);

    await page.goto("/trash");
    await trashedMaterial(page)
      .getByRole("button", { name: `Hapus selamanya materi: ${TITLE}` })
      .click({ timeout: NAVIGATION_TIMEOUT });
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Hapus materi ini untuk selamanya?" }),
    ).toBeVisible();
    await expect(
      dialog.getByText("Teks semua halamannya", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText(/memakai materi ini tetap ada, dengan sumber tertulis/),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Hapus selamanya", exact: true }).click();
    await expect(status(page, "Materi dihapus untuk selamanya.")).toBeVisible({
      timeout: NAVIGATION_TIMEOUT,
    });

    // MAT-11: the question keeps its content; its source line says the material is gone.
    await page.goto(bankPath);
    await expect(
      page.getByText("Materi sumber telah dihapus", { exact: true }),
    ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    await expect(page.getByText(`Sumber: ${TITLE}, hal. 2`)).toHaveCount(0);

    const gone = await page.goto(materialPath);
    expect(gone?.status(), materialPath).toBe(404);
  });
});
