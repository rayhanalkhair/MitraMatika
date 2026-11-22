import { expect, test } from "@playwright/test";
import {
  GENERATION_WAIT,
  T,
  createRequest,
  expedite,
  questionCards,
  resetScenario,
  runDueJobs,
  setScenario,
  waitForFinished,
  waitForQuestions,
  waitForReviewReady,
} from "./helpers";

test.describe("failure scenarios", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ request }) => {
    await resetScenario(request);
  });

  test("malformed JSON that the repair call fixes still yields five questions", async ({
    page,
    request,
  }) => {
    await setScenario(request, "malformed_repairable");
    await createRequest(page);
    await waitForReviewReady(page, 5);
    await expect(questionCards(page).getByText(T.verified, { exact: true })).toHaveCount(
      5,
    );
  });

  test("malformed JSON twice ends as the invalid-output failure with no questions", async ({
    page,
    request,
  }) => {
    await setScenario(request, "malformed_twice");
    await createRequest(page);

    // Every attempt fails; the queue retries after 30 s and then 60 s, so the runner is asked
    // to run what is due until the final attempt has failed the job.
    const failure = page
      .getByRole("alert")
      .filter({ hasText: "Jawaban AI belum bisa dipakai. Coba buat lagi." });
    await expect(async () => {
      await runDueJobs(request);
      await expect(failure).toBeVisible({ timeout: 4_000 });
    }).toPass({ intervals: [1_000], timeout: 200_000 });

    await expect(
      page.getByText("Soal belum dapat dibuat", { exact: true }),
    ).toBeVisible();
    await expect(questionCards(page)).toHaveCount(0);
  });

  test("a persistent wrong key needs an override note to approve", async ({
    page,
    request,
  }) => {
    await setScenario(request, "wrong_key_persistent");
    await createRequest(page);
    await waitForQuestions(page, 5);
    await waitForFinished(page);

    // The one contradicted card (its number depends on the list order), still contradicted after its regeneration.
    const card = questionCards(page).filter({ hasText: T.mismatch });
    await expect(card).toHaveCount(1, { timeout: GENERATION_WAIT });

    await expect(card.getByRole("button", { name: "Setujui", exact: true })).toHaveCount(
      0,
    );
    await card
      .getByRole("button", { name: "Setujui dengan catatan", exact: true })
      .click();

    const dialog = page.getByRole("dialog", {
      name: "Setujui soal yang ditemukan tidak sesuai",
    });
    await expect(dialog).toBeVisible();
    const submit = dialog.getByRole("button", { name: "Setujui soal ini", exact: true });
    const checkbox = dialog.getByRole("checkbox", {
      name: "Saya sudah memeriksa; kunci jawaban benar",
    });
    const note = dialog.getByRole("textbox", { name: "Catatan pemeriksaan Anda" });

    await expect(submit).toBeDisabled();
    await checkbox.check();
    await expect(submit).toBeDisabled();
    await note.fill("terlalu");
    await expect(submit).toBeDisabled();
    await note.fill("Sudah saya periksa sendiri, kuncinya benar.");
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(dialog).toBeHidden();
    await expect(
      card.getByText("Disetujui dengan catatan", { exact: true }),
    ).toBeVisible();
  });

  test("a rate-limited batch is deferred, then resumes and shows five questions", async ({
    page,
    request,
  }) => {
    await setScenario(request, "rate_limited");
    const requestId = await createRequest(page);

    // The first provider call answers 429 and the job is deferred with its resume time.
    await expect(
      page.getByText(
        /Layanan AI sedang membatasi permintaan\. Dilanjutkan otomatis setelah layanan AI tersedia lagi, paling cepat pukul/,
      ),
    ).toBeVisible({ timeout: GENERATION_WAIT });
    await expect(questionCards(page)).toHaveCount(0);

    await page.goto("/home");
    await expect(page.getByText("Menunggu kuota AI", { exact: true })).toBeVisible();

    // Make the deferred job due and run it; the scenario has recovered by itself.
    await expedite(request);
    await page.goto(`/generate/${requestId}`);
    await waitForReviewReady(page, 5);
  });
});
