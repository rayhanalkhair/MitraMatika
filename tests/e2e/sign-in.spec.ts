import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { signedInState } from "./auth";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag22aa"];

test.describe("/sign-in", () => {
  test("renders Google first, then the email and password form, with links to sign-up and forgot password", async ({
    page,
  }) => {
    await page.goto("/sign-in");
    const main = page.getByRole("main");
    await expect(page.getByRole("heading", { level: 1, name: "Masuk" })).toBeVisible();
    await expect(main.getByRole("button", { name: "Masuk dengan Google" })).toBeVisible();
    await expect(main.getByText("atau", { exact: true })).toBeVisible();
    await expect(main.getByLabel("Email", { exact: true })).toHaveAttribute(
      "autocomplete",
      "email",
    );
    await expect(main.getByLabel("Kata sandi", { exact: true })).toHaveAttribute(
      "autocomplete",
      "current-password",
    );
    await expect(main.getByRole("link", { name: "Daftar", exact: true })).toHaveAttribute(
      "href",
      "/sign-up",
    );
    await expect(main.getByRole("link", { name: "Lupa kata sandi?" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
    await expect(main.getByText(/belajar\.id/i)).toHaveCount(0);
  });

  test("shows inline errors and focuses the email field when the form is sent empty", async ({
    page,
  }) => {
    await page.goto("/sign-in");
    const main = page.getByRole("main");
    await main.getByRole("button", { name: "Masuk", exact: true }).click();
    const email = main.getByLabel("Email", { exact: true });
    await expect(email).toHaveAttribute("aria-invalid", "true");
    await expect(email).toBeFocused();
    await expect(main.getByText("Masukkan alamat email yang valid.")).toBeVisible();
    await expect(main.getByText("Masukkan kata sandi.")).toBeVisible();
  });

  test("the password toggle shows the password and reports aria-pressed", async ({
    page,
  }) => {
    await page.goto("/sign-in");
    const main = page.getByRole("main");
    const password = main.getByLabel("Kata sandi", { exact: true });
    const toggle = main.getByRole("button", { name: "Tampilkan kata sandi" });
    await expect(password).toHaveAttribute("type", "password");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(password).toHaveAttribute("type", "text");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  test("a wrong password answers with one generic message", async ({
    page,
  }, testInfo) => {
    // Real Better Auth on the CI database; one project only, to stay inside the per-IP limit.
    test.skip(testInfo.project.name !== "desktop-chromium", "desktop project only");
    await page.goto("/sign-in");
    const main = page.getByRole("main");
    await main.getByLabel("Email", { exact: true }).fill("nobody-e2e@example.test");
    await main.getByLabel("Kata sandi", { exact: true }).fill("salah12345");
    await main.getByRole("button", { name: "Masuk", exact: true }).click();
    await expect(main.getByRole("alert")).toHaveText("Email atau kata sandi salah.");
    await expect(main.getByLabel("Email", { exact: true })).toHaveValue(
      "nobody-e2e@example.test",
    );
  });

  test("shows the password-reset notice", async ({ page }) => {
    await page.goto("/sign-in?notice=passwordReset");
    await expect(page.getByRole("main").getByRole("status")).toHaveText(
      "Kata sandi baru sudah disimpan. Masuk dengan kata sandi itu.",
    );
  });

  test("has no shell navigation", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(page.getByRole("navigation")).toHaveCount(0);
  });

  test("interactive controls meet the 44px touch-target minimum", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/sign-in");
    const main = page.getByRole("main");
    const controls = [
      main.getByRole("button", { name: "Masuk dengan Google" }),
      main.getByLabel("Email", { exact: true }),
      main.getByLabel("Kata sandi", { exact: true }),
      main.getByRole("button", { name: "Tampilkan kata sandi" }),
      main.getByRole("link", { name: "Lupa kata sandi?" }),
      main.getByRole("button", { name: "Masuk", exact: true }),
      main.getByRole("link", { name: "Daftar", exact: true }),
      main.getByRole("button", { name: "English" }),
    ];
    for (const control of controls) {
      const box = await control.boundingBox();
      expect(box, "control has no bounding box").not.toBeNull();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  test("shows a known error from the query string and ignores unknown ones", async ({
    page,
  }) => {
    await page.goto("/sign-in?error=oauthDenied");
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(
      "Masuk dengan Google dibatalkan atau ditolak.",
    );

    await page.goto("/sign-in?error=toString");
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  });

  test("fits without horizontal scroll at phone and desktop widths", async ({
    browser,
  }) => {
    for (const width of [360, 375, 412, 1280]) {
      const context = await browser.newContext({
        viewport: { width, height: 800 },
        baseURL: "http://localhost:3000",
      });
      const page = await context.newPage();
      await page.goto("/sign-in");
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(
        scrollWidth,
        `width=${String(width)}: content overflows horizontally`,
      ).toBeLessThanOrEqual(clientWidth + 1);
      await context.close();
    }
  });

  test("axe WCAG 2.2 AA scan is clean at 375px, 390px and 1280px, with and without an error or notice shown", async ({
    browser,
  }) => {
    for (const width of [375, 390, 1280]) {
      const context = await browser.newContext({
        viewport: { width, height: 800 },
        baseURL: "http://localhost:3000",
      });
      const page = await context.newPage();
      for (const url of [
        "/sign-in",
        "/sign-in?error=generic",
        "/sign-in?notice=passwordReset",
      ]) {
        await page.goto(url);
        const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
        if (results.violations.length > 0) {
          console.log(
            `axe violations on ${url} at ${String(width)}px:`,
            JSON.stringify(
              results.violations.map((v) => ({
                id: v.id,
                impact: v.impact,
                help: v.help,
              })),
              null,
              2,
            ),
          );
        }
        expect(results.violations, `${url} at ${String(width)}px`).toEqual([]);
      }
      await context.close();
    }
  });

  test("keyboard Tab reaches the Google button first", async ({ page }) => {
    await page.goto("/sign-in");
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(
      () => document.activeElement?.textContent.trim() ?? "",
    );
    expect(focused).toBe("Masuk dengan Google");
  });
});

test.describe("sign-out", () => {
  test("desktop: the sidebar has a Keluar button that returns to /sign-in", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: signedInState(),
      viewport: { width: 1280, height: 800 },
      baseURL: "http://localhost:3000",
    });
    const page = await context.newPage();
    await page.goto("/home");
    await page.getByRole("button", { name: "Keluar" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await context.close();
  });

  test("mobile: the Lainnya page has a Keluar button that returns to /sign-in", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/more");
    await page.getByRole("button", { name: "Keluar" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});

test.describe("sign-out without client JavaScript", () => {
  test("mobile: /more Keluar button works with JS disabled", async ({ browser }) => {
    const context = await browser.newContext({
      storageState: signedInState(),
      viewport: { width: 375, height: 800 },
      baseURL: "http://localhost:3000",
      javaScriptEnabled: false,
    });
    const page = await context.newPage();
    await page.goto("/more");
    await page.getByRole("button", { name: "Keluar" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await context.close();
  });

  test("desktop: the sidebar Keluar button works with JS disabled", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: signedInState(),
      viewport: { width: 1280, height: 800 },
      baseURL: "http://localhost:3000",
      javaScriptEnabled: false,
    });
    const page = await context.newPage();
    await page.goto("/home");
    await page.getByRole("button", { name: "Keluar" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await context.close();
  });
});
