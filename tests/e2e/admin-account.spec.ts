import { expect, test } from "@playwright/test";
import { E2E_FAKE_ADMIN_USER } from "../../src/features/auth/service/e2e-session";
import { NAVIGATION_TIMEOUT } from "./helpers";
import { signedInState } from "./auth";

// The ADMIN_EMAIL path of the access gate (ADR-0022) end to end: a verified account that the
// approval list does NOT name is approved only because its address is ADMIN_EMAIL. The fake admin
// identity is seeded by scripts/e2e-seed-user.ts; the seam never approves anyone, the environment
// does. (What the admin receives by mail is covered by the admin-notice unit tests; real delivery
// needs Resend and is not tested here.)
test.use({ storageState: signedInState(E2E_FAKE_ADMIN_USER.email) });

// The same defaults as playwright.config.ts, so the spec reads the environment the server got.
const ALLOWED_EMAILS = process.env.ALLOWED_EMAILS ?? "teacher@example.test";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@example.test";

const APP_PAGES = ["/home", "/materials", "/generate", "/settings", "/question-bank"];

test.describe("admin account", () => {
  test("is approved by ADMIN_EMAIL alone, not by the approval list", () => {
    // Guards the spec itself: if the list named the admin, the tests below would pass for the
    // wrong reason.
    expect(ALLOWED_EMAILS.toLowerCase()).not.toContain(E2E_FAKE_ADMIN_USER.email);
    expect(ADMIN_EMAIL.toLowerCase()).toBe(E2E_FAKE_ADMIN_USER.email);
  });

  test("every app page opens and none lands on /waiting-approval", async ({ page }) => {
    for (const route of APP_PAGES) {
      await page.goto(route);
      await expect(page, route).toHaveURL(new RegExp(`${route}$`), {
        timeout: NAVIGATION_TIMEOUT,
      });
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    }
  });

  test("is sent away from the waiting page to the app", async ({ page }) => {
    await page.goto("/waiting-approval");
    await expect(page).toHaveURL(/\/home$/, { timeout: NAVIGATION_TIMEOUT });
  });

  test("is authorized on API routes (not found, never 401)", async ({ request }) => {
    const file = await request.get(
      "/api/materials/00000000-0000-4000-8000-0000000000aa/file",
      { maxRedirects: 0 },
    );
    expect(file.status()).toBe(404);
  });
});
