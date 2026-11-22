import { expect, test } from "@playwright/test";
import { E2E_FAKE_PENDING_USER } from "../../src/features/auth/service/e2e-session";
import { NAVIGATION_TIMEOUT } from "./helpers";
import { signedInState } from "./auth";

// The access gate (ADR-0022) end to end: a verified account whose email is not on the approval list
// (CI lists only teacher@example.test) is signed in but pending. The fake pending identity is
// seeded by scripts/e2e-seed-user.ts; the seam never approves anyone, the environment does.
test.use({ storageState: signedInState(E2E_FAKE_PENDING_USER.email) });

const GUARDED_PAGES = ["/home", "/materials", "/generate", "/settings", "/question-bank"];

test.describe("pending account", () => {
  test("every app page lands on /waiting-approval", async ({ page }) => {
    for (const route of GUARDED_PAGES) {
      await page.goto(route);
      await expect(page, route).toHaveURL(/\/waiting-approval$/, {
        timeout: NAVIGATION_TIMEOUT,
      });
    }
  });

  test("the waiting page says who is waiting and that the admin was told", async ({
    page,
  }) => {
    await page.goto("/waiting-approval");
    await expect(
      page.getByRole("heading", { level: 1, name: "Menunggu persetujuan admin" }),
    ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    await expect(page.getByText(E2E_FAKE_PENDING_USER.email)).toBeVisible();
    await expect(page.getByText(/Admin sudah diberi tahu/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Cek lagi" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Hapus akun" })).toBeVisible();
    // Checking again while still pending stays on the waiting page.
    await page.getByRole("link", { name: "Cek lagi" }).click();
    await expect(page).toHaveURL(/\/waiting-approval$/, { timeout: NAVIGATION_TIMEOUT });
  });

  test("API routes answer 401 and write nothing", async ({ request }) => {
    const finalize = await request.post("/api/materials/finalize", {
      headers: { "content-type": "application/json" },
      data: {},
      maxRedirects: 0,
    });
    expect(finalize.status()).toBe(401);

    const file = await request.get(
      "/api/materials/00000000-0000-4000-8000-0000000000aa/file",
      { maxRedirects: 0 },
    );
    expect(file.status()).toBe(401);
  });

  test("the privacy notice is readable", async ({ page }) => {
    await page.goto("/waiting-approval");
    await page.getByRole("link", { name: "Pemberitahuan privasi" }).click();
    await expect(page).toHaveURL(/\/privacy$/, { timeout: NAVIGATION_TIMEOUT });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("signing out works and the session is gone", async ({ page }) => {
    await page.goto("/waiting-approval");
    await page.getByRole("button", { name: "Keluar" }).click();
    await expect(page).toHaveURL(/\/sign-in/, { timeout: NAVIGATION_TIMEOUT });
    await page.goto("/waiting-approval");
    await expect(page).toHaveURL(/\/sign-in$/, { timeout: NAVIGATION_TIMEOUT });
  });
});

// Deleting removes the seeded row, so this runs once (the desktop project, after the phone
// project's run) and last in the file.
test.describe("pending account deletes itself", () => {
  test.describe.configure({ mode: "serial" });

  test("the delete dialog refuses another address, then deletes the account", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "deletes the shared seeded account, so it runs in one project only",
    );
    await page.goto("/waiting-approval");
    await page.getByRole("button", { name: "Hapus akun", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Hapus akun untuk selamanya?" });
    await expect(dialog).toBeVisible();
    const input = dialog.getByLabel(`Ketik ${E2E_FAKE_PENDING_USER.email}`);

    await input.fill(E2E_FAKE_PENDING_USER.email.toUpperCase());
    await dialog.getByRole("button", { name: "Hapus akun saya" }).click();
    await expect(
      dialog.getByText("Email yang diketik tidak sama dengan email akun."),
    ).toBeVisible();

    await input.fill(E2E_FAKE_PENDING_USER.email);
    await dialog.getByRole("button", { name: "Hapus akun saya" }).click();
    await expect(page).toHaveURL(/\/sign-in\?notice=accountDeleted$/, {
      timeout: NAVIGATION_TIMEOUT,
    });
  });
});
