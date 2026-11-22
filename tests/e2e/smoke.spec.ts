import { expect, test } from "@playwright/test";

/**
 * P0-05 tooling setup: Playwright was already part of the planned stack
 * (implementation-plan.md, "Vitest, Playwright") but never installed until
 * P0-21 needed reliable mobile-device automation. This smoke test exists to
 * prove the pipeline itself works (dev server, navigation, a real API
 * route) -- there is no real product UI yet to test meaningfully beyond
 * that.
 */
test("home page loads without a client-side error", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");

  await expect(page).toHaveTitle(/MitraMatika|Next\.js/);
  expect(errors).toEqual([]);
});

test("/api/health responds with a status field", async ({ request }) => {
  const response = await request.get("/api/health");
  const body = (await response.json()) as Record<string, unknown>;

  expect(["ok", "degraded"]).toContain(body.status);
  expect(typeof body.timestamp).toBe("string");
});
