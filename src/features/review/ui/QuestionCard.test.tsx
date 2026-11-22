// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";
import { QuestionCard } from "./QuestionCard";

afterEach(cleanup);

const question = {
  questionId: "q1",
  versionId: "v1",
  versionNo: 1,
  rowVersion: 1,
  decision: "draft" as const,
  override: false,
  banked: false,
  difficulty: "sedang" as const,
  stemMd: "Hitung $2+2$.",
  options: [
    { label: "A" as const, textMd: "3" },
    { label: "B" as const, textMd: "4" },
    { label: "C" as const, textMd: "5" },
    { label: "D" as const, textMd: "6" },
  ],
  correctLabel: "B" as const,
  answerDisplayMd: "4",
  explanationMd: "Jumlahkan.",
  steps: ["Tulis soalnya.", "Jumlahkan."],
  sources: [],
  verification: {
    status: "terverifikasi" as const,
    checked: true,
    checks: [],
    crossCheck: "agree" as const,
    regenerated: false,
    regenerationFailed: false,
  },
};

const wiring = () => ({ onDecide: vi.fn(), pending: false, error: null });

describe("QuestionCard", () => {
  it("shows the stem, the four options with the key marked, the answer and the explanation", () => {
    renderWithIntl(
      <QuestionCard number={1} question={question} jobState="finished" {...wiring()} />,
    );
    expect(screen.getByRole("heading", { name: "Soal 1" })).toBeTruthy();
    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(4);
    const key = screen.getByText("Kunci jawaban");
    expect(key.closest("li")?.textContent).toContain("B");
    expect(screen.getByText("Jawaban akhir").parentElement?.textContent).toContain("4");
    expect(screen.getByText("Pembahasan").parentElement?.textContent).toContain(
      "Jumlahkan.",
    );
  });

  it("shows the material page a question was written from, or that it was deleted", () => {
    renderWithIntl(
      <QuestionCard
        number={1}
        question={{
          ...question,
          sources: [
            { title: "Buku SPLDV", page: 3, href: "/materials/m1?page=3" },
            { title: null, page: 5, href: null },
          ],
        }}
        jobState="finished"
        readOnly
      />,
    );
    expect(
      screen
        .getByRole("link", { name: "Sumber: Buku SPLDV, hal. 3" })
        .getAttribute("href"),
    ).toBe("/materials/m1?page=3");
    expect(screen.getByText("Materi sumber telah dihapus")).toBeTruthy();
  });

  it("keeps the steps collapsed until opened", () => {
    const { container } = renderWithIntl(
      <QuestionCard number={1} question={question} jobState="finished" {...wiring()} />,
    );
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toContain(
      "Langkah penyelesaian (2)",
    );
  });

  it("shows 'Sedang diperiksa' while the job is active and no run exists", () => {
    renderWithIntl(
      <QuestionCard
        number={1}
        jobState="running"
        {...wiring()}
        question={{
          ...question,
          verification: {
            ...question.verification,
            checked: false,
            status: "belum_dapat_diverifikasi",
            crossCheck: null,
          },
        }}
      />,
    );
    expect(screen.getAllByText("Sedang diperiksa").length).toBeGreaterThan(0);
    expect(screen.queryByText("Belum dapat diverifikasi")).toBeNull();
  });

  it("shows 'Menunggu pemeriksaan' while the job is deferred and no run exists", () => {
    renderWithIntl(
      <QuestionCard
        number={1}
        jobState="deferred"
        {...wiring()}
        question={{
          ...question,
          verification: { ...question.verification, checked: false, crossCheck: null },
        }}
      />,
    );
    expect(screen.getAllByText("Menunggu pemeriksaan").length).toBeGreaterThan(0);
  });

  it("has a 44 px details button", () => {
    renderWithIntl(
      <QuestionCard number={1} question={question} jobState="finished" {...wiring()} />,
    );
    expect(
      screen.getByRole("button", { name: /Lihat detail pemeriksaan/ }).className,
    ).toMatch(/min-h-11/);
  });

  it("renders the decision bar and passes decisions through", () => {
    const onDecide = vi.fn();
    renderWithIntl(
      <QuestionCard
        number={1}
        question={question}
        jobState="finished"
        onDecide={onDecide}
        pending={false}
        error="Keputusan belum tersimpan. Coba lagi."
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Tolak" }));
    expect(onDecide).toHaveBeenCalledWith("reject");
    expect(screen.getByRole("alert").textContent).toContain("belum tersimpan");
  });

  it("mutes a rejected card and shows the Ditolak line", () => {
    const { container } = renderWithIntl(
      <QuestionCard
        number={1}
        question={{ ...question, decision: "rejected" }}
        jobState="finished"
        {...wiring()}
      />,
    );
    expect(screen.getByText("Ditolak")).toBeTruthy();
    const className = container.querySelector("article")!.className;
    expect(className).toMatch(/bg-muted/);
    // Normal foreground text colour keeps the contrast.
    expect(className).not.toMatch(/text-muted-foreground/);
  });

  it("waits to approve a first-version contradiction while the job runs", () => {
    const contradiction = {
      ...question,
      verification: { ...question.verification, status: "ketidaksesuaian" as const },
    };
    const running = renderWithIntl(
      <QuestionCard
        number={1}
        question={contradiction}
        jobState="running"
        {...wiring()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Menunggu pemeriksaan selesai" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Setujui dengan catatan" })).toBeNull();
    running.unmount();
    renderWithIntl(
      <QuestionCard
        number={1}
        question={contradiction}
        jobState="finished"
        {...wiring()}
      />,
    );
    expect(screen.getByRole("button", { name: "Setujui dengan catatan" })).toBeTruthy();
  });

  it("does not mute a draft card", () => {
    const { container } = renderWithIntl(
      <QuestionCard number={1} question={question} jobState="finished" {...wiring()} />,
    );
    expect(container.querySelector("article")!.className).not.toMatch(/bg-muted/);
  });

  it("renders no decision controls in read-only mode and needs no decision props", () => {
    renderWithIntl(
      <QuestionCard number={1} question={question} jobState="finished" readOnly />,
    );
    expect(screen.queryByRole("button", { name: "Setujui" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Tolak" })).toBeNull();
    expect(screen.queryByText("Tersimpan di Bank Soal")).toBeNull();
    expect(screen.getByText("Kunci jawaban")).toBeTruthy();
  });

  it("uses a heading override as an h2 in read-only mode and keeps h3 'Soal n' otherwise", () => {
    const { unmount } = renderWithIntl(
      <QuestionCard
        number={1}
        question={question}
        jobState="finished"
        readOnly
        heading="Soal tersimpan"
      />,
    );
    expect(
      screen.getByRole("heading", { level: 2, name: "Soal tersimpan" }),
    ).toBeTruthy();
    unmount();
    renderWithIntl(
      <QuestionCard number={2} question={question} jobState="finished" {...wiring()} />,
    );
    expect(screen.getByRole("heading", { level: 3, name: "Soal 2" })).toBeTruthy();
  });

  it("shows the number, difficulty and verification status together in the card header", () => {
    const { container } = renderWithIntl(
      <QuestionCard number={2} question={question} jobState="finished" {...wiring()} />,
    );
    const header = container.querySelector("[data-slot='question-header']")!;
    expect(header.textContent).toContain("Soal 2");
    expect(header.textContent).toContain("Sedang");
    expect(header.querySelector("[data-status='terverifikasi']")).not.toBeNull();
  });

  it("marks the key option with an icon and 'Kunci jawaban'", () => {
    renderWithIntl(
      <QuestionCard number={1} question={question} jobState="finished" {...wiring()} />,
    );
    const li = screen.getByText("Kunci jawaban").closest("li")!;
    expect(li.querySelector("svg")).not.toBeNull();
  });

  it("gives approved cards the success edge, rejected the destructive edge and undecided none", () => {
    const edge = (decision: "draft" | "approved" | "rejected") => {
      const view = renderWithIntl(
        <QuestionCard
          number={1}
          question={{ ...question, decision }}
          jobState="finished"
          {...wiring()}
        />,
      );
      const cls = view.container.querySelector("article")!.className;
      view.unmount();
      return cls;
    };
    expect(edge("approved")).toContain("border-l-success");
    expect(edge("rejected")).toContain("border-l-destructive");
    const draft = edge("draft");
    expect(draft).toContain("border-l-transparent");
    expect(draft).not.toContain("border-l-success");
    expect(draft).not.toContain("border-l-destructive");
  });

  it("typesets a unit exponent in an option and the final answer (B-005)", () => {
    const { container } = renderWithIntl(
      <QuestionCard
        number={1}
        question={{
          ...question,
          options: [
            { label: "A" as const, textMd: "30 cm^2" },
            { label: "B" as const, textMd: "24 cm^2" },
            { label: "C" as const, textMd: "36 cm^2" },
            { label: "D" as const, textMd: "28 cm^2" },
          ],
          answerDisplayMd: "24 cm^2",
        }}
        jobState="finished"
        {...wiring()}
      />,
    );
    expect(container.textContent).not.toContain("cm^2");
    expect(container.querySelectorAll("sup").length).toBe(5);
  });

  it("links to the edit page only when given an edit address", () => {
    const { rerender } = renderWithIntl(
      <QuestionCard number={1} question={question} jobState="finished" {...wiring()} />,
    );
    expect(screen.queryByRole("link", { name: "Ubah soal" })).toBeNull();
    rerender(
      <QuestionCard
        number={1}
        question={question}
        jobState="finished"
        editHref="/question-bank/q1/edit?next=%2Fgenerate%2Fr1"
        {...wiring()}
      />,
    );
    expect(screen.getByRole("link", { name: "Ubah soal" }).getAttribute("href")).toBe(
      "/question-bank/q1/edit?next=%2Fgenerate%2Fr1",
    );
  });
});
