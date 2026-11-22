import { expect, test, type Page } from "@playwright/test";
import {
  NAVIGATION_TIMEOUT,
  T,
  createRequest,
  questionCards,
  resetScenario,
  setScenario,
  waitForReviewReady,
} from "./helpers";

// Saved questions are shared across runs of this file (both device projects use one database),
// so the bank assertions are relative to what was there before.
async function bankRowCount(page: Page): Promise<number> {
  await page.goto("/question-bank");
  await expect(page.getByRole("heading", { level: 1, name: "Bank Soal" })).toBeVisible();
  return page.locator('a[href^="/question-bank/"]').count();
}

test.describe("happy path", () => {
  test.describe.configure({ mode: "serial" });

  test("generate, review, save to the bank, find it again", async ({ page, request }) => {
    await resetScenario(request);
    await setScenario(request, "valid");
    const banked = await bankRowCount(page);

    const requestId = await createRequest(page);
    await expect(
      page.getByRole("heading", { level: 1, name: "Permintaan soal" }),
    ).toBeVisible();

    // Five drafts, all checked by the automatic verifier once the job is done.
    await waitForReviewReady(page, 5);
    const cards = questionCards(page);
    await expect(cards.getByText(T.verified, { exact: true })).toHaveCount(5);
    await expect(page.getByText(T.checking, { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("heading", { level: 3, name: "Soal 1", exact: true }),
    ).toBeVisible();

    // The details sheet opens and closes.
    const first = page.getByRole("article", { name: "Soal 1", exact: true });
    await first.getByRole("button", { name: "Lihat detail pemeriksaan" }).click();
    const sheet = page.getByRole("dialog", { name: "Detail pemeriksaan soal 1" });
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Tutup" }).click();
    await expect(sheet).toBeHidden();

    // Approve card 1, reject card 2.
    const second = page.getByRole("article", { name: "Soal 2", exact: true });
    await first.getByRole("button", { name: "Setujui", exact: true }).click();
    await expect(first.getByText("Disetujui", { exact: true })).toBeVisible();
    await second.getByRole("button", { name: "Tolak", exact: true }).click();
    await expect(second.getByText("Ditolak", { exact: true })).toBeVisible();

    // Save the approved one.
    await expect(page.getByText("1 soal disetujui siap disimpan")).toBeVisible();
    await page.getByRole("button", { name: "Simpan ke Bank Soal" }).click();
    await expect(page.getByText("1 soal tersimpan", { exact: true })).toBeVisible();
    await expect(first.getByText("Tersimpan di Bank Soal")).toBeVisible();

    // The bank has one more row, newest first; its detail has no decision controls.
    await page.getByRole("link", { name: "Buka Bank Soal", exact: true }).click();
    await expect(page).toHaveURL(/\/question-bank$/, { timeout: NAVIGATION_TIMEOUT });
    const rows = page.locator('a[href^="/question-bank/"]');
    await expect(rows).toHaveCount(banked + 1);
    await rows.first().click();
    await expect(page).toHaveURL(/\/question-bank\/[0-9a-f-]{36}$/, {
      timeout: NAVIGATION_TIMEOUT,
    });
    await expect(
      page.getByRole("heading", { level: 1, name: "Detail soal" }),
    ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    await expect(
      page.getByRole("heading", { level: 2, name: "Soal tersimpan" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Setujui" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Tolak" })).toHaveCount(0);

    // Beranda: the counter and the pending draft (3 questions are still undecided).
    await page.goto("/home");
    await expect(
      page
        .getByRole("listitem")
        .filter({ hasText: "Soal di Bank Soal" })
        .getByText(String(banked + 1), { exact: true }),
    ).toBeVisible();
    const pending = page.locator(`a[href="/generate/${requestId}"]`);
    await expect(
      page.getByRole("heading", { level: 2, name: "Draf yang perlu ditinjau" }),
    ).toBeVisible();
    await expect(pending).toBeVisible();
    await expect(pending.getByText("3 belum diputuskan")).toBeVisible();
  });
});
