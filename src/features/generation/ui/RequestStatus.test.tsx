// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";

const hook = vi.hoisted(() => ({ useJobStatus: vi.fn(), useReviewLoaded: vi.fn() }));
vi.mock("@/features/review/ui/use-review-loaded", () => ({
  useReviewLoaded: hook.useReviewLoaded,
}));
vi.mock("@/lib/jobs/client/use-job-status", () => ({
  useJobStatus: hook.useJobStatus,
}));

import { RequestStatus } from "./RequestStatus";

beforeEach(() => {
  hook.useReviewLoaded.mockReturnValue({ loaded: true, isError: false });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-11T07:00:00.000Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const job = (over: Record<string, unknown> = {}) => ({
  id: "j",
  type: "generate_batch",
  status: "queued",
  progress: null,
  error: null,
  runAfter: "2026-10-11T07:30:00.000Z",
  createdAt: "2026-10-11T07:00:00.000Z",
  updatedAt: "2026-10-11T07:00:00.000Z",
  ...over,
});

const state = (data: unknown, extra: Record<string, unknown> = {}) =>
  hook.useJobStatus.mockReturnValue({ data, isError: false, ...extra });

describe("RequestStatus", () => {
  it("shows a loading message before the first result", () => {
    state(undefined);
    renderWithIntl(<RequestStatus requestId="r" jobId="j" />);
    expect(screen.getByRole("status").textContent).toContain("Memuat status");
  });

  it("shows a running job with its progress", () => {
    state({
      kind: "ok",
      job: job({ status: "running", progress: { step: "s", done: 1, total: 4 } }),
    });
    renderWithIntl(<RequestStatus requestId="r" jobId="j" />);
    expect(screen.getByRole("status").textContent).toContain("Soal sedang dibuat");
    expect(screen.getByRole("status").textContent).toContain("Langkah 1 dari 4");
  });

  it("shows the resume message for a deferred job", () => {
    state({ kind: "ok", job: job({ status: "deferred" }) });
    renderWithIntl(<RequestStatus requestId="r" jobId="j" />);
    expect(screen.getByRole("status").textContent).toContain("paling cepat pukul 14.30");
  });

  // S-20: the list is fetched after the job finishes, so do not point at it before it exists.
  it("says the questions are loading until the list has loaded, then that they are below", () => {
    state({ kind: "ok", job: job({ status: "succeeded" }) });
    hook.useReviewLoaded.mockReturnValue({ loaded: false, isError: false });
    const { rerender } = renderWithIntl(<RequestStatus requestId="r" jobId="j" />);
    expect(screen.getByRole("status").textContent).toContain("Soal sedang dimuat…");
    expect(screen.getByRole("status").textContent).not.toContain("Soal ada di bawah");
    hook.useReviewLoaded.mockReturnValue({ loaded: true, isError: false });
    rerender(<RequestStatus requestId="r" jobId="j" />);
    expect(screen.getByRole("status").textContent).toContain("Soal ada di bawah");
    expect(screen.getByRole("status").textContent).not.toContain("sedang dimuat");
  });

  it("does not claim the questions are loading after the list failed to load", () => {
    state({ kind: "ok", job: job({ status: "succeeded" }) });
    hook.useReviewLoaded.mockReturnValue({ loaded: false, isError: true });
    renderWithIntl(<RequestStatus requestId="r" jobId="j" />);
    expect(screen.getByRole("status").textContent).not.toContain("sedang dimuat");
  });

  it("shows a failed job as an alert without technical detail", () => {
    state({
      kind: "ok",
      job: job({ status: "failed", error: { code: "unknown_job_type" } }),
    });
    renderWithIntl(<RequestStatus requestId="r" jobId="j" />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Pembuatan soal belum tersedia.");
    expect(alert.textContent).not.toContain("unknown_job_type");
  });

  it("shows signed-out and not-found notices", () => {
    state({ kind: "signed-out" });
    const { unmount } = renderWithIntl(<RequestStatus requestId="r" jobId="j" />);
    expect(screen.getByRole("alert").textContent).toContain("Sesi berakhir");
    unmount();
    state({ kind: "not-found" });
    renderWithIntl(<RequestStatus requestId="r" jobId="j" />);
    expect(screen.getByRole("alert").textContent).toContain("tidak ditemukan");
  });

  it("shows a reconnecting notice on a transient error", () => {
    state(undefined, { isError: true });
    renderWithIntl(<RequestStatus requestId="r" jobId="j" />);
    expect(screen.getByRole("status").textContent).toContain("Menyambung kembali");
  });

  it("keeps the last known status and adds a reconnecting line when a refetch fails", () => {
    state({ kind: "ok", job: job({ status: "running" }) }, { isError: true });
    renderWithIntl(<RequestStatus requestId="r" jobId="j" />);
    const text = screen.getByRole("status").textContent;
    expect(text).toContain("Soal sedang dibuat");
    expect(text).toContain("Menyambung kembali");
  });

  it("keeps one persistent live region across state changes", () => {
    state(undefined);
    const { rerender } = renderWithIntl(<RequestStatus requestId="r" jobId="j" />);
    const region = screen.getByRole("status");
    state({ kind: "ok", job: job({ status: "running" }) });
    rerender(<RequestStatus requestId="r" jobId="j" />);
    expect(screen.getByRole("status")).toBe(region);
    state({ kind: "ok", job: job({ status: "failed" }) });
    rerender(<RequestStatus requestId="r" jobId="j" />);
    expect(screen.getByRole("status")).toBe(region);
    expect(region.contains(screen.getByRole("alert"))).toBe(true);
  });

  it("explains when the request has no job", () => {
    state(undefined);
    renderWithIntl(<RequestStatus requestId="r" jobId={null} />);
    expect(screen.getByRole("alert").textContent).toContain("tidak ditemukan");
  });
});
