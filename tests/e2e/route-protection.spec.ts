import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { ANONYMOUS_STATE, E2E_RUNNER_SECRET } from "./auth";

const PROTECTED_ROUTES = [
  "/",
  "/home",
  "/generate",
  "/question-bank",
  "/solve",
  "/more",
  "/materials",
  "/assessment-builder",
  "/trash",
  "/settings",
];

// Reachable without a session: the auth screens and the privacy notice.
const PUBLIC_ROUTES = [
  "/sign-up",
  "/verify-email",
  "/forgot-password",
  "/reset-password",
  "/privacy",
];

test.describe("anonymous visitor", () => {
  test.use({ storageState: ANONYMOUS_STATE });

  test("every protected route redirects to /sign-in", async ({ page }) => {
    for (const route of PROTECTED_ROUTES) {
      await page.goto(route);
      await expect(page, route).toHaveURL(/\/sign-in$/);
    }
  });

  test("public routes stay reachable", async ({ page, request }) => {
    await page.goto("/sign-in");
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByRole("heading", { level: 1, name: "Masuk" })).toBeVisible();

    for (const route of PUBLIC_ROUTES) {
      await page.goto(route);
      expect(new URL(page.url()).pathname, route).toBe(route);
      await expect(page.getByRole("heading", { level: 1 }), route).toBeVisible();
    }

    const health = await request.get("/api/health");
    expect(new URL(health.url()).pathname).toBe("/api/health");
    expect(["ok", "degraded"]).toContain(
      ((await health.json()) as { status: unknown }).status,
    );
  });

  test("a POST to a protected route is redirected with 303, not replayed", async ({
    request,
  }) => {
    const response = await request.post("/home", { maxRedirects: 0 });
    expect(response.status()).toBe(303);
    expect(response.headers().location).toMatch(/\/sign-in$/);
  });

  test("the job run route refuses a missing or wrong Bearer secret and accepts the right one with 202", async ({
    request,
  }) => {
    // Refusals first: they schedule nothing. The one accepted POST starts a real run in the dev
    // server (the same call the e2e helper runDueJobs makes), so it is made once, and only the
    // status code and body are asserted, never what the run did.
    const bare = await request.get("/api/jobs/run", { maxRedirects: 0 });
    expect(bare.status(), "GET without a header").toBe(401);
    const wrong = await request.post("/api/jobs/run", {
      headers: { Authorization: `Bearer ${"x".repeat(40)}` },
    });
    expect(wrong.status(), "POST with a wrong secret").toBe(401);

    const accepted = await request.post("/api/jobs/run", {
      headers: { Authorization: `Bearer ${E2E_RUNNER_SECRET}` },
    });
    expect(accepted.status(), "POST with the secret").toBe(202);
    expect(await accepted.json()).toEqual({ accepted: true });
  });

  test("the removed /auth/denied route no longer exists", async ({ request }) => {
    const response = await request.get("/auth/denied", { maxRedirects: 0 });
    expect(response.status()).toBe(404);
  });

  test("axe WCAG 2.2 AA scan is clean on the sign-in error banner at 375px and 1280px", async ({
    browser,
  }) => {
    for (const width of [375, 1280]) {
      const context = await browser.newContext({
        viewport: { width, height: 800 },
        baseURL: "http://localhost:3000",
      });
      const page = await context.newPage();
      await page.goto("/sign-in?error=oauthDenied");
      await expect(page.getByRole("main").getByRole("alert")).toHaveText(
        "Masuk dengan Google dibatalkan atau ditolak.",
      );
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
        .analyze();
      expect(results.violations, `width=${String(width)}`).toEqual([]);
      await context.close();
    }
  });
});

test.describe("signed-in user", () => {
  test("reaches the shell", async ({ page }) => {
    await page.goto("/home");
    await expect(page).toHaveURL(/\/home$/);
    await expect(
      page.getByRole("heading", { level: 1, name: /^(Halo, |Selamat datang)/ }),
    ).toBeVisible();
  });

  test("is protected again after pressing Keluar", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/more");
    await page.getByRole("button", { name: "Keluar" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);

    await page.goto("/home");
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});
