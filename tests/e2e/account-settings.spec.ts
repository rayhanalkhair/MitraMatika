import { expect, test, type Page } from "@playwright/test";
import { E2E_FAKE_USER } from "../../src/features/auth/service/e2e-session";
import {
  DESKTOP,
  NAVIGATION_TIMEOUT,
  PHONE,
  expectNoAxeViolations,
  expectNoHorizontalScroll,
  withViewport,
} from "./helpers";

// Settings > Akun with the fake e2e user (seeded as "Guru Uji", no password: a Google-like
// account). The deletion is never confirmed here: the shared fake user must survive the run.
const SEEDED_NAME = "Guru Uji";

function accountCard(page: Page) {
  return page.getByRole("region", { name: "Akun", exact: true });
}

async function openSettings(page: Page) {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Pengaturan" })).toBeVisible({
    timeout: NAVIGATION_TIMEOUT,
  });
}

async function saveName(page: Page, name: string) {
  const card = accountCard(page);
  await card.getByLabel("Nama lengkap", { exact: true }).fill(name);
  await card.getByRole("button", { name: "Simpan profil" }).click();
}

test.describe("Settings: account card", () => {
  test("shows the account email, the name and school, and no password change for an account without a password", async ({
    page,
  }) => {
    await openSettings(page);
    const card = accountCard(page);
    await expect(card.getByRole("heading", { level: 2, name: "Akun" })).toBeVisible();
    await expect(card.getByText(E2E_FAKE_USER.email)).toBeVisible();
    await expect(card.getByLabel("Nama lengkap", { exact: true })).toHaveAttribute(
      "autocomplete",
      "name",
    );
    await expect(card.getByLabel("Nama sekolah (opsional)")).toBeVisible();
    await expect(card.getByRole("heading", { name: "Ganti kata sandi" })).toHaveCount(0);
    await expect(card.getByLabel("Kata sandi saat ini")).toHaveCount(0);
    await expect(
      card.getByRole("heading", { level: 3, name: "Hapus akun" }),
    ).toBeVisible();
  });

  test("edits the name and school, and refuses an empty name with a focused inline error", async ({
    page,
  }) => {
    await openSettings(page);
    const card = accountCard(page);
    try {
      await saveName(page, "   ");
      const name = card.getByLabel("Nama lengkap", { exact: true });
      await expect(card.getByText("Nama harus 2 sampai 80 karakter.")).toBeVisible();
      await expect(name).toHaveAttribute("aria-invalid", "true");
      await expect(name).toBeFocused();

      await card.getByLabel("Nama sekolah (opsional)").fill("  SMP Uji Coba  ");
      await saveName(page, "  Guru Uji Coba  ");
      await expect(
        card.getByRole("status").getByText("Profil sudah disimpan."),
      ).toBeVisible();

      await page.reload();
      await expect(
        accountCard(page).getByLabel("Nama lengkap", { exact: true }),
      ).toHaveValue("Guru Uji Coba");
      await expect(accountCard(page).getByLabel("Nama sekolah (opsional)")).toHaveValue(
        "SMP Uji Coba",
      );
    } finally {
      // Put the shared fake user back as seeded.
      await openSettings(page);
      await accountCard(page).getByLabel("Nama sekolah (opsional)").fill("");
      await saveName(page, SEEDED_NAME);
      await expect(
        accountCard(page).getByRole("status").getByText("Profil sudah disimpan."),
      ).toBeVisible();
    }
  });

  test("the delete dialog refuses an address that is not the account's and can be cancelled", async ({
    page,
  }) => {
    await openSettings(page);
    const card = accountCard(page);
    const opener = card.getByRole("button", { name: "Hapus akun", exact: true });
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "Hapus akun untuk selamanya?" });
    await expect(dialog).toBeVisible();
    const input = dialog.getByLabel(`Ketik ${E2E_FAKE_USER.email}`);
    await expect(input).toBeFocused();

    // Wrong case is not the account's address. The right address is never typed here.
    await input.fill(E2E_FAKE_USER.email.toUpperCase());
    await dialog.getByRole("button", { name: "Hapus akun saya" }).click();
    await expect(
      dialog.getByText("Email yang diketik tidak sama dengan email akun."),
    ).toBeVisible();
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(input).toBeFocused();
    await expect(page).toHaveURL(/\/settings$/);

    await dialog.getByRole("button", { name: "Batal" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();

    // Escape closes it too.
    await opener.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Still signed in, the account still there.
    await openSettings(page);
    await expect(accountCard(page).getByText(E2E_FAKE_USER.email)).toBeVisible();
  });

  test("controls meet the 44px touch-target minimum", async ({ page }) => {
    await openSettings(page);
    const card = accountCard(page);
    const controls = [
      card.getByLabel("Nama lengkap", { exact: true }),
      card.getByLabel("Nama sekolah (opsional)"),
      card.getByRole("button", { name: "Simpan profil" }),
      card.getByRole("button", { name: "Hapus akun", exact: true }),
    ];
    for (const control of controls) {
      const box = await control.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await card.getByRole("button", { name: "Hapus akun", exact: true }).click();
    const dialog = page.getByRole("dialog");
    for (const name of ["Batal", "Hapus akun saya"]) {
      const box = await dialog.getByRole("button", { name }).boundingBox();
      expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(44);
    }
  });

  test("passes axe and has no horizontal scroll at 390 and 1280 px, with the dialog open too", async ({
    browser,
  }) => {
    for (const viewport of [PHONE, DESKTOP]) {
      await withViewport(browser, { viewport }, async (page) => {
        await openSettings(page);
        await expectNoAxeViolations(page, `/settings ${String(viewport.width)}`);
        await expectNoHorizontalScroll(page, `/settings ${String(viewport.width)}`);
        await accountCard(page)
          .getByRole("button", { name: "Hapus akun", exact: true })
          .click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await expectNoAxeViolations(page, `/settings dialog ${String(viewport.width)}`);
        await expectNoHorizontalScroll(
          page,
          `/settings dialog ${String(viewport.width)}`,
        );
      });
    }
  });
});
