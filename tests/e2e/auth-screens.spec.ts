import { expect, test, type Page } from "@playwright/test";
import { ANONYMOUS_STATE } from "./auth";
import {
  DESKTOP,
  PHONE,
  expectNoAxeViolations,
  expectNoHorizontalScroll,
  withViewport,
} from "./helpers";

// The sign-up, verification and password screens, for a visitor without a session. The flows that
// reach the real Better Auth (on the CI database; email is not configured there, so nothing is
// sent) run in the desktop project only, to stay inside the per-IP limits.
test.use({ storageState: ANONYMOUS_STATE });

function desktopOnly(projectName: string) {
  test.skip(projectName !== "desktop-chromium", "desktop project only");
}

const SCREENS: { url: string; heading: string }[] = [
  { url: "/sign-up", heading: "Daftar" },
  { url: "/verify-email", heading: "Cek email kamu" },
  { url: "/verify-email?error=invalid", heading: "Tautan tidak berlaku" },
  { url: "/forgot-password", heading: "Lupa kata sandi" },
  { url: "/reset-password?token=e2e-token", heading: "Buat kata sandi baru" },
  { url: "/reset-password?error=INVALID_TOKEN", heading: "Tautan tidak berlaku" },
  { url: "/privacy", heading: "Pemberitahuan privasi" },
];

async function showSignUpErrors(page: Page) {
  await page.goto("/sign-up");
  await page.getByRole("main").getByRole("button", { name: "Buat akun" }).click();
  await expect(
    page.getByRole("main").getByLabel("Nama lengkap", { exact: true }),
  ).toBeFocused();
}

test.describe("auth screens", () => {
  test("every screen is public, has one h1, the language switch and no Belajar.id", async ({
    page,
  }) => {
    for (const { url, heading } of SCREENS) {
      await page.goto(url);
      expect(new URL(page.url()).pathname, url).toBe(url.split("?")[0]);
      await expect(page.getByRole("heading", { level: 1 }), url).toHaveText(heading);
      await expect(
        page.getByRole("group", { name: "Bahasa tampilan" }),
        url,
      ).toBeVisible();
      await expect(page.getByText(/belajar\.id/i), url).toHaveCount(0);
    }
  });

  test("axe WCAG 2.2 AA scan is clean at 390px and 1280px on every screen, and on sign-up with errors", async ({
    browser,
  }) => {
    for (const viewport of [PHONE, DESKTOP]) {
      await withViewport(browser, { viewport, anonymous: true }, async (page) => {
        for (const { url } of SCREENS) {
          await page.goto(url);
          await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
          await expectNoAxeViolations(page, `${url} at ${String(viewport.width)}px`);
          await expectNoHorizontalScroll(page, `${url} at ${String(viewport.width)}px`);
        }
        await showSignUpErrors(page);
        await expectNoAxeViolations(
          page,
          `/sign-up with errors at ${String(viewport.width)}px`,
        );
      });
    }
  });

  test("sign-up validates every field inline and links the privacy notice", async ({
    page,
  }) => {
    await showSignUpErrors(page);
    const main = page.getByRole("main");
    const expectations: [string, string][] = [
      ["Nama lengkap", "Nama harus 2 sampai 80 karakter."],
      ["Email", "Masukkan alamat email yang valid."],
      ["Kata sandi", "Kata sandi minimal 8 karakter."],
    ];
    for (const [label, message] of expectations) {
      const field = main.getByLabel(label, { exact: true });
      await expect(field, label).toHaveAttribute("aria-invalid", "true");
      const describedBy = (await field.getAttribute("aria-describedby")) ?? "";
      await expect(page.locator(`[id="${describedBy.split(" ")[0]}"]`), label).toHaveText(
        message,
      );
    }
    await expect(
      main.getByText("Setujui pemberitahuan privasi untuk mendaftar."),
    ).toBeVisible();
    await expect(
      main.getByRole("link", { name: "pemberitahuan privasi" }),
    ).toHaveAttribute("href", "/privacy");
  });

  test.describe("without JavaScript", () => {
    // Sign-up is the one form that works without JavaScript (D-044): its <form action> is the
    // Server Action, and the server render of the refused post carries the inline errors and the
    // values typed. Scripting is off for this page, so React never hydrates it.
    test.use({ javaScriptEnabled: false });

    test("sign-up shows server field errors with JavaScript disabled", async ({
      page,
    }) => {
      await page.goto("/sign-up");
      const main = page.getByRole("main");
      await main.getByLabel("Nama lengkap", { exact: true }).fill("Guru Uji");
      await main.getByLabel("Email", { exact: true }).fill("bukan-email");
      await main.getByLabel("Kata sandi", { exact: true }).fill("rahasia123");
      await main.getByLabel("Ulangi kata sandi", { exact: true }).fill("rahasia123");
      await main.getByRole("checkbox").check();
      await main.getByRole("button", { name: "Buat akun" }).click();

      const email = main.getByLabel("Email", { exact: true });
      await expect(email).toHaveAttribute("aria-invalid", "true");
      const describedBy = (await email.getAttribute("aria-describedby")) ?? "";
      await expect(page.locator(`[id="${describedBy.split(" ")[0]}"]`)).toHaveText(
        "Masukkan alamat email yang valid.",
      );
      // The typed values come back in the server render; the passwords never do.
      await expect(email).toHaveValue("bukan-email");
      await expect(main.getByLabel("Nama lengkap", { exact: true })).toHaveValue(
        "Guru Uji",
      );
      await expect(main.getByLabel("Kata sandi", { exact: true })).toHaveValue("");
    });
  });

  test("sign-up controls meet the 44px touch-target minimum", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/sign-up");
    const main = page.getByRole("main");
    const controls = [
      main.getByRole("button", { name: "Daftar dengan Google" }),
      main.getByLabel("Nama lengkap", { exact: true }),
      main.getByLabel("Email", { exact: true }),
      main.getByLabel("Kata sandi", { exact: true }),
      main.getByLabel("Ulangi kata sandi", { exact: true }),
      main.getByLabel("Nama sekolah (opsional)", { exact: true }),
      main.getByRole("button", { name: "Tampilkan kata sandi" }).first(),
      main.getByRole("button", { name: "Buat akun" }),
      main.getByRole("link", { name: "Masuk", exact: true }),
      // The checkbox box is 24 px; the label row around it is the 44 px target.
      main.locator("[data-slot='privacy-target']"),
    ];
    for (const control of controls) {
      const box = await control.boundingBox();
      expect(box, "control has no bounding box").not.toBeNull();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  test("after sign-up the user sees the verify-email notice with the resend on a countdown", async ({
    page,
  }, testInfo) => {
    desktopOnly(testInfo.project.name);
    const email = `e2e-sign-up-${String(Date.now())}@example.test`;
    await page.goto("/sign-up");
    const main = page.getByRole("main");
    await main.getByLabel("Nama lengkap", { exact: true }).fill("Guru Uji");
    await main.getByLabel("Email", { exact: true }).fill(email);
    await main.getByLabel("Kata sandi", { exact: true }).fill("rahasia123");
    await main.getByLabel("Ulangi kata sandi", { exact: true }).fill("rahasia123");
    await main.getByRole("checkbox").check();
    await main.getByRole("button", { name: "Buat akun" }).click();

    await expect(page).toHaveURL(/\/verify-email$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Cek email kamu");
    await expect(page.getByRole("main").getByLabel("Email", { exact: true })).toHaveValue(
      email,
    );
    const resend = page
      .getByRole("main")
      .getByRole("button", { name: /^Kirim ulang dalam \d+ detik$/ });
    await expect(resend).toBeDisabled();
  });

  test("the verify-email error landing allows a resend at once, with the same answer for any address", async ({
    page,
  }, testInfo) => {
    desktopOnly(testInfo.project.name);
    await page.goto("/verify-email?error=invalid");
    const main = page.getByRole("main");
    await main
      .getByLabel("Email", { exact: true })
      .fill("nobody-verify-e2e@example.test");
    await main.getByRole("button", { name: "Kirim ulang tautan" }).click();
    await expect(main.getByRole("status")).toHaveText(
      "Jika alamat itu menunggu konfirmasi, tautan baru sudah dikirim.",
    );
    await expect(
      main.getByRole("button", { name: /^Kirim ulang dalam \d+ detik$/ }),
    ).toBeDisabled();
    // The "sent" status colour on the card.
    await expectNoAxeViolations(page, "/verify-email after a resend");
  });

  test("forgot password always shows the same confirmation", async ({
    page,
  }, testInfo) => {
    desktopOnly(testInfo.project.name);
    await page.goto("/forgot-password");
    const main = page.getByRole("main");
    await main.getByLabel("Email", { exact: true }).fill("nobody-reset-e2e@example.test");
    await main.getByRole("button", { name: "Kirim tautan" }).click();
    await expect(main.getByRole("status")).toHaveText(
      "Jika ada akun dengan email itu, kami sudah mengirim tautan untuk membuat kata sandi baru. Tautan berlaku 1 jam. Periksa juga folder spam.",
    );
    await expect(main.getByRole("button", { name: "Kirim tautan" })).toHaveCount(0);
    await expectNoAxeViolations(page, "/forgot-password confirmation");
  });

  test("a reset with an unknown token shows the expired message and a link to a new one", async ({
    page,
  }, testInfo) => {
    desktopOnly(testInfo.project.name);
    await page.goto("/reset-password?token=e2e-not-a-real-token");
    const main = page.getByRole("main");
    await main.getByLabel("Kata sandi baru", { exact: true }).fill("baru12345");
    await main.getByLabel("Ulangi kata sandi", { exact: true }).fill("baru12345");
    await main.getByRole("button", { name: "Simpan kata sandi" }).click();
    await expect(main.getByRole("alert")).toContainText(
      "Tautan ini sudah kedaluwarsa atau pernah dipakai.",
    );
    await expect(main.getByRole("link", { name: "Minta tautan baru" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
  });

  test("a missing reset token shows the expired message", async ({ page }) => {
    await page.goto("/reset-password");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Tautan tidak berlaku",
    );
    await expect(
      page.getByRole("main").getByRole("link", { name: "Minta tautan baru" }),
    ).toHaveAttribute("href", "/forgot-password");
  });
});
