// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/features/trash/actions/trash", () => ({ trashQuestionAction: vi.fn() }));
vi.mock("@/lib/jobs/client/use-job-status", () => ({
  useJobStatus: () => ({ data: undefined }),
}));
import type { BankQuestion } from "@/features/bank/service/bank";
import { BankDetail } from "./BankDetail";

afterEach(cleanup);

const bankQuestion: BankQuestion = {
  bankedAt: "2026-11-08T10:00:00.000Z",
  curriculum: {
    versionCode: "KM-2025",
    versionTitle: "Kurikulum",
    elementCode: "BIL",
    elementName: "Bilangan",
    topicTitle: "Bilangan Bulat",
    objectives: [{ code: "7.1", text: "Operasi bilangan bulat" }],
    sourceAnchor: null,
  },
  question: {
    questionId: "q1",
    versionId: "v1",
    versionNo: 1,
    rowVersion: 3,
    decision: "approved",
    override: false,
    banked: true,
    difficulty: "sedang",
    stemMd: "Hitung $2+2$.",
    options: [
      { label: "A", textMd: "3" },
      { label: "B", textMd: "4" },
      { label: "C", textMd: "5" },
      { label: "D", textMd: "6" },
    ],
    correctLabel: "B",
    answerDisplayMd: "4",
    explanationMd: "Jumlahkan.",
    steps: ["Tulis soalnya.", "Jumlahkan."],
    sources: [],
    verification: {
      status: "terverifikasi",
      checked: true,
      checks: [],
      crossCheck: "agree",
      regenerated: false,
      regenerationFailed: false,
    },
  },
};

describe("BankDetail", () => {
  it("links to the version history of the question", () => {
    renderWithIntl(<BankDetail bankQuestion={bankQuestion} />);
    expect(screen.getByRole("link", { name: "Riwayat versi" }).getAttribute("href")).toBe(
      "/question-bank/q1/history",
    );
  });

  it("shows the saved question read-only with no decision controls", () => {
    renderWithIntl(<BankDetail bankQuestion={bankQuestion} />);
    expect(screen.getByRole("heading", { level: 1, name: "Detail soal" })).toBeTruthy();
    expect(screen.getByText("Kunci jawaban")).toBeTruthy();
    expect(screen.getByText("Terverifikasi otomatis")).toBeTruthy();
    for (const name of ["Setujui", "Tolak", "Batalkan keputusan"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.queryByText("Tersimpan di Bank Soal")).toBeNull();
  });

  it("shows the saved date, the curriculum panel and a back link", () => {
    renderWithIntl(<BankDetail bankQuestion={bankQuestion} />);
    expect(screen.getByText("Disimpan 8 November 2026")).toBeTruthy();
    expect(screen.getByText("Bilangan Bulat")).toBeTruthy();
    const back = screen.getByRole("link", { name: "Kembali ke Bank Soal" });
    expect(back.getAttribute("href")).toBe("/question-bank");
    expect(back.className).toContain("min-h-11");
  });

  it("shows options, answer key, explanation, steps, source and verification details", () => {
    renderWithIntl(
      <BankDetail
        bankQuestion={{
          ...bankQuestion,
          curriculum: { ...bankQuestion.curriculum!, sourceAnchor: "Buku Siswa hlm. 12" },
        }}
      />,
    );
    const text = document.body.textContent;
    for (const expected of [
      "Kunci jawaban",
      "Pembahasan",
      "Jumlahkan.",
      "Tulis soalnya.",
      "Buku Siswa hlm. 12",
      "Terverifikasi otomatis",
    ]) {
      expect(text).toContain(expected);
    }
    expect(screen.getByRole("list", { name: "Pilihan jawaban" })).toBeTruthy();
  });

  it("omits the curriculum panel without curriculum", () => {
    renderWithIntl(<BankDetail bankQuestion={{ ...bankQuestion, curriculum: null }} />);
    expect(screen.queryByText("Bilangan Bulat")).toBeNull();
  });

  it("titles the card with an h2 under the h1 and never as 'Soal 1'", () => {
    renderWithIntl(<BankDetail bankQuestion={bankQuestion} />);
    expect(
      screen.getByRole("heading", { level: 2, name: "Soal tersimpan" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Soal 1" })).toBeNull();
    expect(screen.queryAllByRole("heading", { level: 3 })).toHaveLength(0);
  });

  it("offers to regenerate the saved question", () => {
    renderWithIntl(<BankDetail bankQuestion={bankQuestion} />);
    const regenerate = screen.getByRole("button", { name: "Buat ulang" });
    expect(regenerate.getAttribute("aria-expanded")).toBe("false");
    expect(regenerate.className).toContain("min-h-11");
  });

  it("links to the edit page of the saved question", () => {
    renderWithIntl(<BankDetail bankQuestion={bankQuestion} />);
    const edit = screen.getByRole("link", { name: "Ubah soal" });
    expect(edit.getAttribute("href")).toBe("/question-bank/q1/edit");
    expect(edit.className).toContain("min-h-11");
  });

  it("offers to move the question to the trash", () => {
    renderWithIntl(<BankDetail bankQuestion={bankQuestion} />);
    const trash = screen.getByRole("button", {
      name: "Pindahkan ke Sampah: Bilangan Bulat",
    });
    expect(trash.className).toContain("min-h-11");
  });
});
