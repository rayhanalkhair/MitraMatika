// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";

const hooks = vi.hoisted(() => ({
  useJobStatus: vi.fn(),
  useRequestReview: vi.fn(),
  decide: vi.fn(),
  isPending: vi.fn(),
  errorFor: vi.fn(),
}));
vi.mock("@/lib/jobs/client/use-job-status", () => ({
  useJobStatus: hooks.useJobStatus,
}));
vi.mock("./use-request-review", () => ({ useRequestReview: hooks.useRequestReview }));
vi.mock("./use-question-decision", () => ({
  useQuestionDecision: () => ({
    decide: hooks.decide,
    isPending: hooks.isPending,
    errorFor: hooks.errorFor,
    pendingQuestionIds: new Set<string>(),
  }),
}));

vi.mock("./use-bank-approved", () => ({
  useBankApproved: () => ({ save: vi.fn(), pending: false, result: null }),
}));

import { ReviewList } from "./ReviewList";

afterEach(cleanup);
beforeEach(() => {
  hooks.decide.mockReset().mockResolvedValue({ ok: true });
  hooks.isPending.mockReset().mockReturnValue(false);
  hooks.errorFor.mockReset().mockReturnValue(null);
});

const job = (status: string) => ({
  data: {
    kind: "ok",
    job: {
      id: "j",
      type: "generate_batch",
      status,
      progress: null,
      error: null,
      runAfter: "x",
      createdAt: "x",
      updatedAt: "x",
    },
  },
});
const q = (n: number, over: Record<string, unknown> = {}) => ({
  questionId: `q${String(n)}`,
  versionId: `v${String(n)}`,
  versionNo: 1,
  rowVersion: 1,
  decision: "draft",
  override: false,
  banked: false,
  difficulty: "sedang",
  stemMd: `Soal $${String(n)}$`,
  options: ["A", "B", "C", "D"].map((label) => ({ label, textMd: label })),
  correctLabel: "B",
  answerDisplayMd: "2",
  explanationMd: "ok",
  steps: ["a", "b"],
  sources: [],
  verification: {
    status: "belum_dapat_diverifikasi",
    checked: false,
    checks: [],
    crossCheck: null,
    regenerated: false,
    regenerationFailed: false,
    ...over,
  },
});
const review = (questions: unknown[], requested = questions.length) => ({
  data: { kind: "ok", review: { requested, curriculum: null, questions } },
  isError: false,
});

describe("ReviewList", () => {
  it("offers regeneration on every card once the job has finished, not while it runs", () => {
    hooks.useJobStatus.mockReturnValue(job("running"));
    hooks.useRequestReview.mockReturnValue(review([q(1), q(2)]));
    const running = renderWithIntl(<ReviewList requestId="r" jobId="j" />);
    expect(screen.queryAllByRole("button", { name: "Buat ulang" })).toHaveLength(0);
    running.unmount();

    hooks.useJobStatus.mockReturnValue(job("succeeded"));
    renderWithIntl(<ReviewList requestId="r" jobId="j" />);
    expect(screen.getAllByRole("button", { name: "Buat ulang" })).toHaveLength(2);
  });

  it("renders nothing until a question exists", () => {
    hooks.useJobStatus.mockReturnValue(job("running"));
    hooks.useRequestReview.mockReturnValue(review([]));
    const { container } = renderWithIntl(<ReviewList requestId="r" jobId="j" />);
    expect(container.textContent).toBe("");
    // The live region is mounted but empty, so the first count is announced when it fills.
    expect(screen.getByRole("status").textContent).toBe("");
  });

  // S-20: after the job succeeds the list takes a few seconds to arrive; fill the gap.
  it("shows three busy skeleton cards while the finished job's list is loading", () => {
    hooks.useJobStatus.mockReturnValue(job("succeeded"));
    hooks.useRequestReview.mockReturnValue({ data: undefined, isError: false });
    const { container } = renderWithIntl(<ReviewList requestId="r" jobId="j" />);
    const busy = container.querySelector('[aria-busy="true"]');
    expect(busy).not.toBeNull();
    expect(busy?.querySelectorAll("li")).toHaveLength(3);
    expect(busy?.querySelector('[class*="motion-safe:animate-pulse"]')).not.toBeNull();
    expect(busy?.querySelector(".sr-only")?.textContent).toBe("Memuat soal…");
  });

  it("shows no skeleton while the job is running, once loaded, or on a load error", () => {
    hooks.useJobStatus.mockReturnValue(job("running"));
    hooks.useRequestReview.mockReturnValue({ data: undefined, isError: false });
    const first = renderWithIntl(<ReviewList requestId="r" jobId="j" />);
    expect(first.container.querySelector("[aria-busy]")).toBeNull();
    first.unmount();

    hooks.useJobStatus.mockReturnValue(job("succeeded"));
    hooks.useRequestReview.mockReturnValue(review([q(1)]));
    const second = renderWithIntl(<ReviewList requestId="r" jobId="j" />);
    expect(second.container.querySelector("[aria-busy]")).toBeNull();
    second.unmount();

    hooks.useRequestReview.mockReturnValue({ data: undefined, isError: true });
    const third = renderWithIntl(<ReviewList requestId="r" jobId="j" />);
    expect(third.container.querySelector("[aria-busy]")).toBeNull();
    expect(third.container.textContent).toContain("Menyambung kembali");
  });

  it("shows 'Menunggu pemeriksaan' for unchecked questions while the job is deferred and polls slowly", () => {
    hooks.useJobStatus.mockReturnValue(job("deferred"));
    hooks.useRequestReview.mockReturnValue(review([q(1)]));
    renderWithIntl(<ReviewList requestId="r" jobId="j" />);
    expect(screen.getAllByText("Menunggu pemeriksaan").length).toBeGreaterThan(0);
    expect(screen.queryByText("Sedang diperiksa")).toBeNull();
    expect(hooks.useRequestReview).toHaveBeenLastCalledWith("r", "deferred");
  });

  it("passes the job status to the review hook while it runs and treats it as unknown while loading", () => {
    hooks.useJobStatus.mockReturnValue(job("running"));
    hooks.useRequestReview.mockReturnValue(review([]));
    const { unmount } = renderWithIntl(<ReviewList requestId="r" jobId="j" />);
    expect(hooks.useRequestReview).toHaveBeenLastCalledWith("r", "running");
    unmount();

    hooks.useJobStatus.mockReturnValue({ data: undefined, isPending: true });
    renderWithIntl(<ReviewList requestId="r" jobId="j" />);
    expect(hooks.useRequestReview).toHaveBeenLastCalledWith("r", undefined);
  });

  it("polls slowly when the job query failed without data", () => {
    hooks.useJobStatus.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
    });
    hooks.useRequestReview.mockReturnValue(review([q(1)]));
    renderWithIntl(<ReviewList requestId="r" jobId="j" />);
    expect(hooks.useRequestReview).toHaveBeenLastCalledWith("r", "unreachable");
    expect(screen.getAllByText("Sedang diperiksa").length).toBeGreaterThan(0);
  });

  it("stops polling without a job and for a signed-out or not-found job answer", () => {
    hooks.useRequestReview.mockReturnValue(review([q(1)]));

    hooks.useJobStatus.mockReturnValue({ data: undefined, isPending: false });
    const first = renderWithIntl(<ReviewList requestId="r" jobId={null} />);
    expect(hooks.useRequestReview).toHaveBeenLastCalledWith("r", "stopped");
    // No job means nothing is being checked: the stored status is shown.
    expect(screen.getAllByText("Belum dapat diverifikasi").length).toBeGreaterThan(0);
    expect(screen.queryByText("Sedang diperiksa")).toBeNull();
    first.unmount();

    for (const kind of ["signed-out", "not-found"]) {
      hooks.useJobStatus.mockReturnValue({ data: { kind }, isPending: false });
      const view = renderWithIntl(<ReviewList requestId="r" jobId="j" />);
      expect(hooks.useRequestReview).toHaveBeenLastCalledWith("r", "stopped");
      expect(screen.queryByText("Sedang diperiksa")).toBeNull();
      view.unmount();
    }
  });

  it("updates a checking question to its final status on the next poll", () => {
    hooks.useJobStatus.mockReturnValue(job("running"));
    hooks.useRequestReview.mockReturnValue(review([q(1)]));
    const { rerender } = renderWithIntl(<ReviewList requestId="r" jobId="j" />);
    expect(screen.getAllByText("Sedang diperiksa").length).toBeGreaterThan(0);

    hooks.useRequestReview.mockReturnValue(
      review([q(1, { checked: true, status: "terverifikasi", crossCheck: "agree" })]),
    );
    rerender(<ReviewList requestId="r" jobId="j" />);
    expect(screen.queryByText("Sedang diperiksa")).toBeNull();
    expect(screen.getAllByText("Terverifikasi otomatis").length).toBeGreaterThan(0);
  });

  it("shows the heading, the disclaimer and the count line when fewer questions than requested", () => {
    hooks.useJobStatus.mockReturnValue(job("succeeded"));
    hooks.useRequestReview.mockReturnValue(review([q(1), q(2), q(3)], 5));
    renderWithIntl(<ReviewList requestId="r" jobId="j" />);
    expect(screen.getByRole("heading", { name: "Soal untuk ditinjau" })).toBeTruthy();
    expect(
      screen.getByText("Pemeriksaan otomatis tidak menjamin kebenaran."),
    ).toBeTruthy();
    expect(screen.getByText("Menampilkan 3 dari 5 soal")).toBeTruthy();
  });

  it("shows the list when the job failed but drafts exist", () => {
    hooks.useJobStatus.mockReturnValue(job("failed"));
    hooks.useRequestReview.mockReturnValue(
      review([q(1, { checked: true, status: "ketidaksesuaian" })]),
    );
    renderWithIntl(<ReviewList requestId="r" jobId="j" />);
    expect(screen.getAllByText("Ditemukan ketidaksesuaian").length).toBeGreaterThan(0);
  });

  it("does not crash for a finished job without questions, a signed-out or not-found answer", () => {
    hooks.useJobStatus.mockReturnValue(job("succeeded"));
    for (const data of [
      { kind: "ok", review: { requested: 2, curriculum: null, questions: [] } },
      { kind: "signed-out" },
      { kind: "not-found" },
      undefined,
    ]) {
      hooks.useRequestReview.mockReturnValue({ data, isError: false });
      const { container, unmount } = renderWithIntl(
        <ReviewList requestId="r" jobId="j" />,
      );
      expect(container.querySelectorAll("h2").length).toBe(0);
      unmount();
    }
  });

  it("announces the number of questions once in a polite live region", () => {
    hooks.useJobStatus.mockReturnValue(job("running"));
    hooks.useRequestReview.mockReturnValue(review([q(1), q(2)]));
    renderWithIntl(<ReviewList requestId="r" jobId="j" />);
    const live = screen.getByRole("status");
    expect(live.textContent).toContain("2 soal siap ditinjau");
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("keeps the list and says it is reconnecting after a failed poll", () => {
    hooks.useJobStatus.mockReturnValue(job("running"));
    hooks.useRequestReview.mockReturnValue({ ...review([q(1)]), isError: true });
    renderWithIntl(<ReviewList requestId="r" jobId="j" />);
    expect(screen.getByText("Menyambung kembali…")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Soal 1" })).toBeTruthy();
  });

  it("decides with the question (versionId and rowVersion included) when Setujui is clicked", () => {
    hooks.useJobStatus.mockReturnValue(job("succeeded"));
    const first = q(1, { checked: true, status: "terverifikasi", crossCheck: "agree" });
    hooks.useRequestReview.mockReturnValue(
      review([first, q(2, { checked: true, status: "terverifikasi" })]),
    );
    renderWithIntl(<ReviewList requestId="r" jobId="j" />);
    fireEvent.click(screen.getAllByRole("button", { name: "Setujui" })[0]);
    expect(hooks.decide).toHaveBeenCalledTimes(1);
    expect(hooks.decide.mock.calls[0][0]).toMatchObject({
      questionId: "q1",
      versionId: "v1",
      rowVersion: 1,
    });
    expect(hooks.decide.mock.calls[0][1]).toBe("approve");
  });

  it("shows the optimistic decision from the cached review immediately", () => {
    hooks.useJobStatus.mockReturnValue(job("succeeded"));
    hooks.useRequestReview.mockReturnValue(review([{ ...q(1), decision: "approved" }]));
    renderWithIntl(<ReviewList requestId="r" jobId="j" />);
    expect(screen.getByText("Disetujui")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Batalkan keputusan" })).toBeTruthy();
  });

  it("passes the pending flag and the error per question", () => {
    hooks.useJobStatus.mockReturnValue(job("succeeded"));
    hooks.useRequestReview.mockReturnValue(review([q(1), q(2)]));
    hooks.isPending.mockImplementation((id: string) => id === "q1");
    hooks.errorFor.mockImplementation((id: string) =>
      id === "q2" ? "Gagal simpan." : null,
    );
    renderWithIntl(<ReviewList requestId="r" jobId="j" />);
    const [firstReject, secondReject] = screen.getAllByRole("button", { name: "Tolak" });
    expect((firstReject as HTMLButtonElement).disabled).toBe(true);
    expect((secondReject as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("alert").textContent).toBe("Gagal simpan.");
  });

  describe("save to bank bar", () => {
    it("counts only approved, unbanked questions as ready", () => {
      hooks.useJobStatus.mockReturnValue(job("succeeded"));
      hooks.useRequestReview.mockReturnValue(
        review([
          { ...q(1), decision: "approved" },
          { ...q(2), decision: "approved" },
          { ...q(3), decision: "approved", banked: true },
          { ...q(4), decision: "rejected" },
          q(5),
        ]),
      );
      renderWithIntl(<ReviewList requestId="r" jobId="j" />);
      expect(screen.getByText("2 soal disetujui siap disimpan")).toBeTruthy();
      expect(
        screen
          .getByRole("button", { name: "Simpan ke Bank Soal" })
          .hasAttribute("disabled"),
      ).toBe(false);
    });

    it("shows the bar disabled when nothing is approved", () => {
      hooks.useJobStatus.mockReturnValue(job("succeeded"));
      hooks.useRequestReview.mockReturnValue(review([q(1)]));
      renderWithIntl(<ReviewList requestId="r" jobId="j" />);
      expect(screen.getByText("Belum ada soal yang disetujui")).toBeTruthy();
      expect(
        screen
          .getByRole("button", { name: "Simpan ke Bank Soal" })
          .hasAttribute("disabled"),
      ).toBe(true);
    });

    it("has no bar without questions", () => {
      hooks.useJobStatus.mockReturnValue(job("running"));
      hooks.useRequestReview.mockReturnValue(review([]));
      renderWithIntl(<ReviewList requestId="r" jobId="j" />);
      expect(screen.queryByRole("button", { name: "Simpan ke Bank Soal" })).toBeNull();
    });
  });

  it("keeps the list and save bar in one readable column with the bar in normal flow", () => {
    hooks.useJobStatus.mockReturnValue(job("succeeded"));
    hooks.useRequestReview.mockReturnValue(review([q(1), q(2)]));
    const { container } = renderWithIntl(<ReviewList requestId="r" jobId="j" />);
    const section = container.querySelector("section[aria-labelledby='review-heading']")!;
    expect(section.className).toContain("max-w-4xl");
    expect(section.className).toContain("mx-auto");
    expect(section.className).not.toContain("pb-28");
    const bar = screen
      .getByRole("button", { name: "Simpan ke Bank Soal" })
      .closest(".sticky");
    expect(bar).not.toBeNull();
    expect(screen.getByText("0 dari 2 disetujui")).toBeTruthy();
  });

  it("offers the edit page for a question that is not saved, once the job has finished", () => {
    hooks.useJobStatus.mockReturnValue(job("succeeded"));
    hooks.useRequestReview.mockReturnValue(
      review([q(1), { ...q(2), decision: "approved", banked: true }]),
    );
    renderWithIntl(<ReviewList requestId="r1" jobId="j" />);
    const links = screen.getAllByRole("link", { name: "Ubah soal" });
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/question-bank/q1/edit?next=%2Fgenerate%2Fr1",
    ]);
  });

  it("offers no edit page while the job still runs", () => {
    hooks.useJobStatus.mockReturnValue(job("running"));
    hooks.useRequestReview.mockReturnValue(review([q(1)]));
    renderWithIntl(<ReviewList requestId="r1" jobId="j" />);
    expect(screen.queryByRole("link", { name: "Ubah soal" })).toBeNull();
  });
});
