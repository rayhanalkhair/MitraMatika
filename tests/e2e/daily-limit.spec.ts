import { expect, test } from "@playwright/test";
import { fillDailyUsage, resetScenario, submitRequest } from "./helpers";

const MONTHS_ID = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

// The next Asia/Jakarta midnight (UTC+7, no DST) as "19 November 2026".
function nextJakartaMidnightDate(now = new Date()): string {
  const jakarta = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const next = new Date(
    Date.UTC(jakarta.getUTCFullYear(), jakarta.getUTCMonth(), jakarta.getUTCDate() + 1),
  );
  return `${String(next.getUTCDate())} ${MONTHS_ID[next.getUTCMonth()]} ${String(next.getUTCFullYear())}`;
}

test.describe("daily question limit", () => {
  // The reset time is shown in the viewer's time zone (cookie from the browser, default Jakarta).
  test.use({ timezoneId: "Asia/Jakarta" });

  test.afterEach(async ({ request }) => {
    await resetScenario(request);
  });

  test("a teacher past 30 questions today sees the limit and when it resets", async ({
    page,
    request,
  }) => {
    await resetScenario(request);
    await fillDailyUsage(request);

    await submitRequest(page);

    const alert = page
      .getByRole("alert")
      .filter({ hasText: "Kamu sudah meminta 30 dari 30 soal hari ini." });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("Sisa 0 soal.");
    await expect(alert).toContainText(
      new RegExp(
        `Batas harian dihitung ulang pada ${nextJakartaMidnightDate()}.*00[.:]00`,
      ),
    );
    // No request was created: the page is still the form.
    await expect(page).toHaveURL(/\/generate(\?.*)?$/);
  });
});
