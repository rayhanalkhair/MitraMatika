import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  DESKTOP,
  GENERATION_WAIT,
  NAVIGATION_TIMEOUT,
  PHONE,
  T,
  expectNoAxeViolations,
  expectNoHorizontalScroll,
  resetScenario,
  setScenario,
  waitForReviewReady,
  withViewport,
} from "./helpers";

// One assessment travels through the whole file: a school template is made in Settings, three
// questions are generated and banked through the editor's /generate round trip, picked into the
// assessment, scored, shuffled, approved, previewed, exported, reopened, trashed and restored. The
// tests share it, so they run in order. The file is a generation spec (playwright.config.ts): it
// uses the fake user's one request slot and the scripted AI. resetScenario also deletes the fake
// user's assessments, templates and exports, so it runs before and after the file, not after each
// test.
const TOKEN = String(Date.now());
const TEMPLATE_NAME = `Kop ujian ${TOKEN}`;
const SCHOOL_NAME = "SMP Negeri Contoh";
const TITLE = `Ulangan SPLDV ${TOKEN}`;
const EDITOR_PATH = /\/assessment-builder\/[0-9a-f-]{36}$/;
// The status page of a generation request that knows the way back to the editor.
const REQUEST_WITH_RETURN =
  /\/generate\/[0-9a-f-]{36}\?returnTo=%2Fassessment-builder%2F[0-9a-f-]{36}/;
const EXPORT_WAIT = 180_000;

let editorPath = "";

function status(scope: Page | Locator, text: string | RegExp) {
  return scope.getByRole("status").filter({ hasText: text });
}

function exportFiles(page: Page) {
  return page.getByRole("list", { name: "Berkas ekspor" });
}

async function openEditor(page: Page) {
  await page.goto(editorPath);
  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible({
    timeout: NAVIGATION_TIMEOUT,
  });
}

async function confirmMoveToTrash(page: Page, heading: string) {
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: heading })).toBeVisible();
  await dialog.getByRole("button", { name: "Pindahkan ke Sampah", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: NAVIGATION_TIMEOUT });
}

test.describe("assessment builder and export", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ request }) => {
    await resetScenario(request);
  });

  test.afterAll(async ({ request }) => {
    await resetScenario(request);
  });

  test("a school template is made in Settings and becomes the default", async ({
    page,
  }) => {
    await page.goto("/settings");
    const card = page.getByRole("region", { name: "Templat dokumen" });
    await expect(card).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    await expect(
      card.getByText("Belum ada templat. Buat yang pertama di bawah ini."),
    ).toBeVisible();

    await card.getByLabel("Nama templat", { exact: true }).fill(TEMPLATE_NAME);
    await card.getByLabel("Nama sekolah", { exact: true }).fill(SCHOOL_NAME);
    await card.getByLabel("Baris kop 1", { exact: true }).fill("Dinas Pendidikan Kota");
    await card.getByRole("button", { name: "Simpan templat" }).click();
    await expect(status(card, "Templat sudah disimpan.")).toBeVisible({
      timeout: NAVIGATION_TIMEOUT,
    });

    // The first template is the default one.
    const row = card
      .getByRole("list", { name: "Daftar templat" })
      .getByRole("listitem")
      .filter({ hasText: TEMPLATE_NAME });
    await expect(row.getByText("Default", { exact: true })).toBeVisible({
      timeout: NAVIGATION_TIMEOUT,
    });
  });

  test("create an assessment, bank three questions through /generate and come back", async ({
    page,
    request,
  }) => {
    await setScenario(request, "valid");
    await page.goto("/assessment-builder");
    const form = page.getByRole("region", { name: "Asesmen baru" });
    await expect(form).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    await form.getByLabel("Judul", { exact: true }).fill(TITLE);
    // The default template is preselected for a new assessment.
    await expect(form.getByLabel("Templat dokumen", { exact: true })).toContainText(
      `${TEMPLATE_NAME} (default)`,
    );
    await form.getByRole("button", { name: "Buat asesmen" }).click();
    await expect(page).toHaveURL(EDITOR_PATH, { timeout: NAVIGATION_TIMEOUT });
    editorPath = new URL(page.url()).pathname;
    await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();

    // "Buat soal baru" opens /generate with the way back (Task 4's returnTo round trip).
    await page.getByRole("link", { name: "Buat soal baru" }).click();
    await expect(page).toHaveURL(/\/generate\?returnTo=/, {
      timeout: NAVIGATION_TIMEOUT,
    });
    const search = page.getByRole("searchbox", { name: T.topicSearch });
    await search.fill(T.topicQuery);
    await expect(page.getByText("1 topik ditemukan", { exact: true })).toBeVisible();
    const topic = page.getByRole("radio", { name: T.topicTitle });
    await topic.check();
    await expect(topic).toBeChecked();
    await page.getByRole("button", { name: T.submit, exact: true }).click();
    await page.waitForURL(REQUEST_WITH_RETURN, { timeout: GENERATION_WAIT });
    await waitForReviewReady(page, 5);

    for (const name of ["Soal 1", "Soal 2", "Soal 3"]) {
      const card = page.getByRole("article", { name, exact: true });
      await card.getByRole("button", { name: "Setujui", exact: true }).click();
      await expect(card.getByText("Disetujui", { exact: true })).toBeVisible();
    }
    await page.getByRole("button", { name: "Simpan ke Bank Soal" }).click();
    await expect(page.getByText("3 soal tersimpan", { exact: true })).toBeVisible();

    // Back in the editor, the three new bank questions are offered, all checked.
    await page.getByRole("link", { name: "Kembali ke asesmen" }).click();
    await expect(page).toHaveURL(/\/assessment-builder\/[0-9a-f-]{36}\?since=/, {
      timeout: NAVIGATION_TIMEOUT,
    });
    const offer = page.getByRole("region", { name: "Soal baru di Bank Soal" });
    await expect(
      offer.getByText("3 soal baru tersimpan di Bank Soal dan belum ada di asesmen ini."),
    ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    await expect(offer.getByRole("checkbox", { checked: true })).toHaveCount(3);
  });

  test("pick the three questions from the bank with the picker", async ({ page }) => {
    await openEditor(page);
    await page.getByRole("link", { name: "Tambah soal dari Bank Soal" }).click();
    const picker = page.getByRole("region", { name: /^Tambah soal ke / });
    await expect(picker).toBeVisible({ timeout: NAVIGATION_TIMEOUT });

    // The bank lists the most recently banked first: the three just saved.
    for (const n of [1, 2, 3]) {
      await picker.getByRole("checkbox", { name: `Pilih soal ${String(n)}` }).check();
    }
    await picker.getByRole("button", { name: "Tambahkan 3 soal" }).click();
    await expect(
      status(page, "3 soal ditambahkan, 0 dilewati karena sudah ada."),
    ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    await expect(page.getByText("3 soal dalam 1 bagian", { exact: true })).toBeVisible();
  });

  test("equal scoring, shuffle on, then approve", async ({ page }) => {
    await openEditor(page);
    const scoring = page.getByRole("region", { name: "Skor dan urutan" });

    // Equal is the default; switching away and back saves it explicitly.
    // The radios are controlled: they show as checked once the server has saved the mode, so
    // click and wait instead of check(), which demands an immediate state change.
    await scoring.getByRole("radio", { name: /^Manual\s*Isi skor/ }).click();
    await expect(status(page, "Cara penilaian disimpan.")).toBeVisible();
    await expect(scoring.getByRole("radio", { name: /^Manual\s*Isi skor/ })).toBeChecked({
      timeout: NAVIGATION_TIMEOUT,
    });
    await scoring.getByRole("radio", { name: /^Sama rata/ }).click();
    await expect(scoring.getByRole("radio", { name: /^Sama rata/ })).toBeChecked({
      timeout: NAVIGATION_TIMEOUT,
    });
    await expect(scoring.getByText("Total skor: 100", { exact: true })).toBeVisible();

    await scoring
      .getByRole("checkbox", { name: "Acak urutan soal di setiap bagian" })
      .click();
    await expect(status(page, "Urutan soal diacak.")).toBeVisible();
    await expect(scoring.getByRole("button", { name: "Acak ulang" })).toBeVisible();

    const approval = page.getByRole("region", { name: "Persetujuan" });
    await expect(approval.getByText(/^Siap disetujui\./)).toBeVisible();
    await approval.getByRole("button", { name: "Setujui asesmen" }).click();
    await expect(status(page, "Asesmen disetujui.")).toBeVisible({
      timeout: NAVIGATION_TIMEOUT,
    });
    // Locked: no picker link, and the export panel is there.
    await expect(page.getByText(/^Asesmen ini sudah disetujui/)).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Tambah soal dari Bank Soal" }),
    ).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Ekspor dokumen" })).toBeVisible();
  });

  test("the preview switches between paper, key and solutions in a sandboxed frame", async ({
    page,
  }) => {
    await openEditor(page);
    await page.getByRole("link", { name: "Pratinjau dokumen" }).click();
    await expect(page).toHaveURL(/\/preview$/, { timeout: NAVIGATION_TIMEOUT });
    const kinds = page.getByRole("navigation", { name: "Jenis dokumen" });
    await expect(kinds).toBeVisible({ timeout: NAVIGATION_TIMEOUT });

    const frame = page.locator("iframe");
    await expect(frame).toHaveCount(1);
    await expect(frame).toHaveAttribute("sandbox", "");
    await expect(frame).toHaveAttribute("title", "Pratinjau dokumen: Naskah soal");
    await expect(frame).toHaveAttribute("srcdoc", new RegExp(SCHOOL_NAME));
    await expect(kinds.getByRole("link", { name: "Naskah soal" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    for (const [kind, label] of [
      ["key", "Kunci jawaban"],
      ["solutions", "Pembahasan"],
    ] as const) {
      await kinds.getByRole("link", { name: label }).click();
      await expect(page).toHaveURL(new RegExp(`kind=${kind}$`), {
        timeout: NAVIGATION_TIMEOUT,
      });
      await expect(kinds.getByRole("link", { name: label })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expect(frame).toHaveAttribute("title", `Pratinjau dokumen: ${label}`);
      await expect(frame).toHaveAttribute("sandbox", "");
    }
  });

  test("export: six documents and a ZIP, a download redirects to a signed URL", async ({
    page,
  }) => {
    await openEditor(page);
    const panel = page.getByRole("region", { name: "Ekspor dokumen" });
    await panel.getByRole("button", { name: "Ekspor dokumen" }).click();
    // The job runs in the dev server after the action (and on the status poll); the page
    // refreshes when it is done.
    const files = exportFiles(page);
    await expect(
      files.getByRole("link", { name: "Unduh semua berkas (ZIP)" }),
    ).toBeVisible({ timeout: EXPORT_WAIT });
    await expect(status(panel, "Dokumen siap diunduh.")).toBeVisible();

    const names = [
      "Unduh Naskah soal (PDF)",
      "Unduh Naskah soal (Word)",
      "Unduh Kunci jawaban (PDF)",
      "Unduh Kunci jawaban (Word)",
      "Unduh Pembahasan (PDF)",
      "Unduh Pembahasan (Word)",
      "Unduh semua berkas (ZIP)",
    ];
    for (const name of names) {
      await expect(files.getByRole("link", { name, exact: true })).toBeVisible();
    }
    await expect(files.getByRole("link")).toHaveCount(names.length);
    await expect(panel.getByText(/^Tersedia sampai /)).toBeVisible();

    // The download route answers with a short-lived signed URL (the in-memory store of `next dev`
    // signs with a placeholder host), named after the title, never the file itself.
    const href = await files
      .getByRole("link", { name: "Unduh Naskah soal (PDF)", exact: true })
      .getAttribute("href");
    expect(href).toMatch(/^\/api\/exports\/[0-9a-f-]{36}$/);
    const response = await page.request.get(href ?? "", { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    expect(response.headers()["cache-control"]).toContain("no-store");
    const location = response.headers().location;
    expect(location).toMatch(
      /^https:\/\/memory\.invalid\/exports\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/paper\.pdf\?/,
    );
    expect(new URL(location).searchParams.get("download")).toBe(
      `ulangan-spldv-${TOKEN}-naskah-soal.pdf`,
    );
  });

  test("reopen the approved assessment, then editing works again", async ({ page }) => {
    await openEditor(page);
    const approval = page.getByRole("region", { name: "Persetujuan" });
    await approval.getByRole("button", { name: "Buka kembali" }).click();
    await approval.getByRole("button", { name: "Ya, buka kembali" }).click();
    await expect(status(page, "Asesmen dibuka kembali.")).toBeVisible({
      timeout: NAVIGATION_TIMEOUT,
    });
    await expect(
      page.getByRole("link", { name: "Tambah soal dari Bank Soal" }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Ekspor dokumen" })).toHaveCount(0);

    const details = page.getByRole("region", { name: "Detail asesmen" });
    await details.getByLabel("Durasi (menit)", { exact: true }).fill("80");
    await details.getByRole("button", { name: "Simpan detail" }).click();
    await expect(status(details, "Detail disimpan.")).toBeVisible({
      timeout: NAVIGATION_TIMEOUT,
    });
    await page.reload();
    await expect(
      page
        .getByRole("region", { name: "Detail asesmen" })
        .getByLabel("Durasi (menit)", { exact: true }),
    ).toHaveValue("80", { timeout: NAVIGATION_TIMEOUT });
  });

  test("axe is clean on the builder, editor, preview and Settings at 1280 and 390 px", async ({
    browser,
  }) => {
    const paths = [
      "/assessment-builder",
      editorPath,
      `${editorPath}/preview`,
      `${editorPath}/preview?kind=key`,
      "/settings",
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
        // The picker, open.
        await page.goto(editorPath);
        await page.getByRole("link", { name: "Tambah soal dari Bank Soal" }).click();
        await expect(page.getByRole("region", { name: /^Tambah soal ke / })).toBeVisible({
          timeout: NAVIGATION_TIMEOUT,
        });
        const label = `the open picker at ${String(viewport.width)} px`;
        await expectNoAxeViolations(page, label);
        if (viewport.width === PHONE.width) await expectNoHorizontalScroll(page, label);
      });
    }
  });

  test("axe is clean on the details form after a refused save, and the title stays saved", async ({
    page,
  }) => {
    await openEditor(page);
    const details = page.getByRole("region", { name: "Detail asesmen" });
    const title = details.getByLabel("Judul", { exact: true });
    // A click before React hydrates does not run the client validation, so repeat it until the
    // empty title is refused inline.
    await expect(async () => {
      await title.fill("");
      await details.getByRole("button", { name: "Simpan detail" }).click();
      await expect(title).toHaveAttribute("aria-invalid", "true", { timeout: 2_000 });
    }).toPass({ timeout: NAVIGATION_TIMEOUT, intervals: [500, 1_000, 2_000] });
    await expect(details.getByText("Wajib diisi.")).toBeVisible();
    await expectNoAxeViolations(page, "the assessment details form after a refused save");

    // Nothing was saved: the saved title is still there after a reload.
    await openEditor(page);
  });

  test("trash the assessment and the template, then restore both from /trash", async ({
    page,
    browser,
  }) => {
    await page.goto("/assessment-builder");
    const list = page.getByRole("list", { name: "Daftar asesmen" });
    await expect(list).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    await list
      .getByRole("button", { name: `Pindahkan ke Sampah: ${TITLE}`, exact: true })
      .click();
    await confirmMoveToTrash(page, "Pindahkan asesmen ke Sampah?");
    await expect(page.getByRole("link", { name: new RegExp(TITLE) })).toHaveCount(0, {
      timeout: NAVIGATION_TIMEOUT,
    });

    await page.goto("/settings");
    const card = page.getByRole("region", { name: "Templat dokumen" });
    await expect(card).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    await card
      .getByRole("button", { name: `Pindahkan ke Sampah: ${TEMPLATE_NAME}`, exact: true })
      .click();
    await confirmMoveToTrash(page, "Pindahkan templat ke Sampah?");
    await expect(
      card.getByRole("list", { name: "Daftar templat" }).getByText(TEMPLATE_NAME),
    ).toHaveCount(0, { timeout: NAVIGATION_TIMEOUT });

    // Both are in the trash; axe and scroll are checked with them in place.
    await page.goto("/trash");
    await expect(page.getByRole("heading", { level: 1, name: "Sampah" })).toBeVisible({
      timeout: NAVIGATION_TIMEOUT,
    });
    const trashedAssessment = page
      .getByRole("list", { name: "Asesmen di Sampah" })
      .getByRole("listitem")
      .filter({ hasText: TITLE });
    const trashedTemplate = page
      .getByRole("list", { name: "Templat di Sampah" })
      .getByRole("listitem")
      .filter({ hasText: TEMPLATE_NAME });
    await expect(trashedAssessment).toBeVisible();
    await expect(trashedTemplate).toBeVisible();
    await expect(
      trashedTemplate.getByText(`Masih dipakai oleh asesmen “${TITLE}”`),
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

    await trashedTemplate
      .getByRole("button", { name: `Pulihkan templat: ${TEMPLATE_NAME}`, exact: true })
      .click();
    await expect(status(page, /^Templat dipulihkan/)).toBeVisible({
      timeout: NAVIGATION_TIMEOUT,
    });
    await trashedAssessment
      .getByRole("button", { name: `Pulihkan asesmen: ${TITLE}`, exact: true })
      .click();
    await expect(
      status(page, "Asesmen dipulihkan ke tempat asalnya, dengan persetujuannya."),
    ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });

    // Back where they were.
    await page.goto("/assessment-builder");
    await expect(
      page
        .getByRole("list", { name: "Daftar asesmen" })
        .getByRole("link", { name: new RegExp(TITLE) }),
    ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    await openEditor(page);
    await expect(page.getByText("3 soal dalam 1 bagian", { exact: true })).toBeVisible();
    await page.goto("/settings");
    await expect(
      page
        .getByRole("region", { name: "Templat dokumen" })
        .getByRole("list", { name: "Daftar templat" })
        .getByText(TEMPLATE_NAME),
    ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
  });
});
