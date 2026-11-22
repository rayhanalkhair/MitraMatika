// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/test/intl";

const mocks = vi.hoisted(() => ({
  regenerateQuestionAction: vi.fn(),
  restoreVersionAction: vi.fn(),
  job: vi.fn(),
  calls: [] as (string | null)[],
}));
vi.mock("../actions/regenerate-question", () => ({
  regenerateQuestionAction: mocks.regenerateQuestionAction,
}));
vi.mock("@/features/bank/actions/restore-version", () => ({
  restoreVersionAction: mocks.restoreVersionAction,
}));
vi.mock("@/lib/jobs/client/use-job-status", () => ({
  useJobStatus: (id: string | null) => {
    mocks.calls.push(id);
    return id === null ? { data: undefined } : (mocks.job(id) as unknown);
  },
}));

import type { ReviewQuestion } from "../service/review";
import { RegenerateControl } from "./RegenerateControl";

const JOB_ID = "33333333-3333-4333-8333-333333333333";

const question = (n: number, over: Partial<ReviewQuestion> = {}): ReviewQuestion => ({
  questionId: "q1",
  versionId: `v${String(n)}`,
  versionNo: n,
  rowVersion: n + 2,
  decision: "draft",
  override: false,
  banked: false,
  difficulty: "sedang",
  stemMd: `Soal versi ${String(n)}`,
  options: (["A", "B", "C", "D"] as const).map((label) => ({
    label,
    textMd: `${label}${String(n)}`,
  })),
  correctLabel: "B",
  answerDisplayMd: `jawab ${String(n)}`,
  explanationMd: "ok",
  steps: ["a", "b"],
  sources: [],
  verification: {
    status: "terverifikasi",
    checked: true,
    checks: [],
    crossCheck: "agree",
    regenerated: n > 1,
    regenerationFailed: false,
  },
  ...over,
});

const jobState = (
  status: string,
  progress: Record<string, unknown> | null = null,
  runAfter = new Date().toISOString(),
) => ({
  data: {
    kind: "ok",
    job: {
      id: JOB_ID,
      type: "regenerate_question",
      status,
      progress,
      error: null,
      runAfter,
      createdAt: "x",
      updatedAt: "x",
    },
  },
});

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
  mocks.job.mockReturnValue(jobState("queued"));
  mocks.regenerateQuestionAction.mockResolvedValue({
    ok: true,
    jobId: JOB_ID,
    deferredUntil: null,
  });
  mocks.restoreVersionAction.mockResolvedValue({ ok: true, versionId: "v3" });
});

async function startRegeneration(
  user: ReturnType<typeof userEvent.setup>,
  hintLabel?: RegExp,
) {
  await user.click(screen.getByRole("button", { name: /^buat ulang$/i }));
  if (hintLabel) await user.click(screen.getByRole("radio", { name: hintLabel }));
  await user.click(screen.getByRole("button", { name: /buat ulang soal/i }));
}

describe("RegenerateControl", () => {
  it("opens the hint picker and sends no hint by default", async () => {
    const user = userEvent.setup();
    renderWithIntl(<RegenerateControl question={question(1)} onSettled={vi.fn()} />);
    const toggle = screen.getByRole("button", { name: /^buat ulang$/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getByRole<HTMLInputElement>("radio", { name: /tanpa petunjuk/i }).checked,
    ).toBe(true);
    expect(screen.getByText(/dihitung 1 soal dari batas harian/i)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /buat ulang soal/i }));
    expect(mocks.regenerateQuestionAction).toHaveBeenCalledWith({
      questionId: "q1",
      hint: null,
    });
  });

  it("sends a preset hint", async () => {
    const user = userEvent.setup();
    renderWithIntl(<RegenerateControl question={question(1)} onSettled={vi.fn()} />);
    await startRegeneration(user, /lebih mudah/i);
    expect(mocks.regenerateQuestionAction).toHaveBeenCalledWith({
      questionId: "q1",
      hint: "easier",
    });
  });

  it("caps the teacher's own hint at 200 characters", async () => {
    const user = userEvent.setup();
    renderWithIntl(<RegenerateControl question={question(1)} onSettled={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /^buat ulang$/i }));
    await user.click(screen.getByRole("radio", { name: /tulis sendiri/i }));
    const box = screen.getByRole("textbox", { name: /petunjuk anda/i });
    expect(box.getAttribute("maxLength")).toBe("200");
    await user.type(box, "k".repeat(205));
    expect((box as HTMLTextAreaElement).value).toHaveLength(200);
    expect(screen.getByText("200 dari 200 karakter")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /buat ulang soal/i }));
    expect(mocks.regenerateQuestionAction).toHaveBeenCalledWith({
      questionId: "q1",
      hint: { text: "k".repeat(200) },
    });
  });

  it("shows the resume time while the job waits for the AI quota", async () => {
    const user = userEvent.setup();
    const later = new Date(Date.now() + 2 * 3_600_000).toISOString();
    mocks.job.mockReturnValue(
      jobState("deferred", { step: "deferred", messageKey: "quota_daily" }, later),
    );
    renderWithIntl(<RegenerateControl question={question(1)} onSettled={vi.fn()} />);
    await startRegeneration(user);
    expect(
      await screen.findByText(/kuota ai harian habis.*paling cepat pukul \d{2}\.\d{2}/i),
    ).toBeTruthy();
    expect(mocks.calls).toContain(JOB_ID);
  });

  it("shows the daily limit with its reset time and starts nothing", async () => {
    const user = userEvent.setup();
    mocks.regenerateQuestionAction.mockResolvedValue({
      ok: false,
      reason: "daily_limit",
      limit: 30,
      used: 30,
      remaining: 0,
      resetsAt: "2026-11-08T17:00:00.000Z",
    });
    renderWithIntl(<RegenerateControl question={question(1)} onSettled={vi.fn()} />);
    await startRegeneration(user);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/batas harian 30 soal sudah tercapai/i);
    expect(alert.textContent).toMatch(/9 November 2026/);
    expect(mocks.calls.every((id) => id === null)).toBe(true);
  });

  it("follows a regeneration that is already pending", async () => {
    const user = userEvent.setup();
    mocks.regenerateQuestionAction.mockResolvedValue({
      ok: false,
      reason: "pending",
      jobId: JOB_ID,
    });
    mocks.job.mockReturnValue(jobState("running"));
    renderWithIntl(<RegenerateControl question={question(1)} onSettled={vi.fn()} />);
    await startRegeneration(user);
    expect(await screen.findByText(/soal sedang dibuat ulang/i)).toBeTruthy();
    expect(mocks.calls).toContain(JOB_ID);
  });

  it("side-by-side view shows both versions and restore previous creates n+2 copying n", async () => {
    const user = userEvent.setup();
    const onSettled = vi.fn();
    const view = renderWithIntl(
      <RegenerateControl question={question(1)} onSettled={onSettled} />,
    );
    await startRegeneration(user);
    mocks.job.mockReturnValue(jobState("succeeded", { step: "saved" }));
    view.rerender(<RegenerateControl question={question(1)} onSettled={onSettled} />);
    await waitFor(() => {
      expect(onSettled).toHaveBeenCalledTimes(1);
    });

    // The refreshed question is version 2: the old one is still known to the control.
    view.rerender(<RegenerateControl question={question(2)} onSettled={onSettled} />);
    const compare = screen.getByRole("region", { name: /bandingkan versi/i });
    // A real heading (the e2e waits for it): one level under a review card's h3.
    expect(
      within(compare).getByRole("heading", { name: "Bandingkan versi", level: 4 }),
    ).toBeTruthy();
    const previous = within(compare).getByRole("group", {
      name: /versi sebelumnya \(1\)/i,
    });
    const fresh = within(compare).getByRole("group", { name: /versi baru \(2\)/i });
    expect(within(previous).getByText("Soal versi 1")).toBeTruthy();
    expect(within(fresh).getByText("Soal versi 2")).toBeTruthy();
    // "Keep new" is the default: the first action, and nothing happens without a click.
    const buttons = within(compare).getAllByRole("button");
    expect(buttons[0].textContent).toMatch(/pakai versi baru/i);

    await user.click(
      within(compare).getByRole("button", { name: /kembalikan versi sebelumnya/i }),
    );
    expect(mocks.restoreVersionAction).toHaveBeenCalledWith({
      questionId: "q1",
      versionId: "v1",
      expectedRowVersion: 4,
    });
    await waitFor(() => {
      expect(onSettled).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByRole("region", { name: /bandingkan versi/i })).toBeNull();
    expect(screen.getByText(/versi sebelumnya dipulihkan/i)).toBeTruthy();
  });

  it("titles the comparison one level under the card it sits in", async () => {
    const user = userEvent.setup();
    const view = renderWithIntl(
      <RegenerateControl
        question={question(1)}
        onSettled={vi.fn()}
        compareHeadingLevel={3}
      />,
    );
    await startRegeneration(user);
    mocks.job.mockReturnValue(jobState("succeeded", { step: "saved" }));
    view.rerender(
      <RegenerateControl
        question={question(2)}
        onSettled={vi.fn()}
        compareHeadingLevel={3}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Bandingkan versi", level: 3 }),
    ).toBeTruthy();
  });

  it("keep new closes the comparison without writing anything", async () => {
    const user = userEvent.setup();
    const view = renderWithIntl(
      <RegenerateControl question={question(1)} onSettled={vi.fn()} />,
    );
    await startRegeneration(user);
    mocks.job.mockReturnValue(jobState("succeeded", { step: "saved" }));
    view.rerender(<RegenerateControl question={question(2)} onSettled={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /pakai versi baru/i }));
    expect(screen.queryByRole("region", { name: /bandingkan versi/i })).toBeNull();
    expect(mocks.restoreVersionAction).not.toHaveBeenCalled();
  });

  it("tells the teacher when a stale restore was refused", async () => {
    const user = userEvent.setup();
    mocks.restoreVersionAction.mockResolvedValue({ ok: false, reason: "stale" });
    const view = renderWithIntl(
      <RegenerateControl question={question(1)} onSettled={vi.fn()} />,
    );
    await startRegeneration(user);
    mocks.job.mockReturnValue(jobState("succeeded", { step: "saved" }));
    view.rerender(<RegenerateControl question={question(2)} onSettled={vi.fn()} />);
    await user.click(
      screen.getByRole("button", { name: /kembalikan versi sebelumnya/i }),
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(/sudah berubah/i);
  });

  it("says so when the new version went back to review", async () => {
    const user = userEvent.setup();
    const onSettled = vi.fn();
    const view = renderWithIntl(
      <RegenerateControl question={question(1)} onSettled={onSettled} />,
    );
    await startRegeneration(user);
    mocks.job.mockReturnValue(jobState("succeeded", { step: "returned_to_review" }));
    view.rerender(<RegenerateControl question={question(1)} onSettled={onSettled} />);
    expect(
      await screen.findByText(/tidak lolos pemeriksaan.*kembali ke peninjauan/i),
    ).toBeTruthy();
    expect(onSettled).toHaveBeenCalledWith("returned_to_review");
  });

  it("says the old question is unchanged when the job failed", async () => {
    const user = userEvent.setup();
    mocks.job.mockReturnValue(jobState("failed"));
    renderWithIntl(<RegenerateControl question={question(1)} onSettled={vi.fn()} />);
    await startRegeneration(user);
    expect(await screen.findByText(/soal lama tidak berubah/i)).toBeTruthy();
  });
  it("returns focus to the toggle on cancel and to the status after sending", async () => {
    const user = userEvent.setup();
    renderWithIntl(<RegenerateControl question={question(1)} onSettled={vi.fn()} />);
    const toggle = screen.getByRole("button", { name: /^buat ulang$/i });
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: /^batal$/i }));
    expect(document.activeElement).toBe(toggle);

    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: /buat ulang soal/i }));
    // The toggle is disabled while the job runs, so focus goes to the progress it announces.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("status"));
    });
  });

  it("returns focus to the toggle after a restore", async () => {
    const user = userEvent.setup();
    const view = renderWithIntl(
      <RegenerateControl question={question(1)} onSettled={vi.fn()} />,
    );
    await startRegeneration(user);
    mocks.job.mockReturnValue(jobState("succeeded", { step: "saved" }));
    view.rerender(<RegenerateControl question={question(2)} onSettled={vi.fn()} />);
    await user.click(
      screen.getByRole("button", { name: /kembalikan versi sebelumnya/i }),
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: /^buat ulang$/i }),
      );
    });
  });
});
