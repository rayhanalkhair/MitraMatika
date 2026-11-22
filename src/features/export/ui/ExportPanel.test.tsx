// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/test/intl";

const mocks = vi.hoisted(() => ({
  startExportAction: vi.fn(),
  job: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("../actions/start-export", () => ({
  startExportAction: mocks.startExportAction,
}));
vi.mock("@/lib/jobs/client/use-job-status", () => ({
  useJobStatus: (id: string | null) =>
    id === null ? { data: undefined } : (mocks.job(id) as unknown),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

import type { ExportPanelData, ExportPanelFile } from "../service/export-panel";
import { ExportPanel } from "./ExportPanel";

const ASSESSMENT = "11111111-1111-4111-8111-111111111111";
const JOB = "33333333-3333-4333-8333-333333333333";
const EXPIRES = "2026-11-27T03:00:00.000Z";

const file = (
  document: ExportPanelFile["document"],
  format: ExportPanelFile["format"],
  warnings: ExportPanelFile["warnings"] = [],
): ExportPanelFile => ({
  id: `${document}-${format}`,
  document,
  format,
  expiresAt: EXPIRES,
  warnings,
});

const ALL: ExportPanelFile[] = [
  file("paper", "pdf"),
  file("paper", "docx", [
    { code: "mathFailed", where: { part: "stem", number: 3 } },
    { code: "logoOmitted" },
  ]),
  file("key", "pdf"),
  file("key", "docx", [{ code: "logoOmitted" }]),
  file("solutions", "pdf", [{ code: "logoMissing" }]),
  file("solutions", "docx", [{ code: "logoMissing" }]),
  file("zip", "zip"),
];

const jobState = (status: string, error: { code: string } | null = null) => ({
  data: {
    kind: "ok",
    job: {
      id: JOB,
      type: "render_export",
      status,
      progress: null,
      error,
      runAfter: "x",
      createdAt: "x",
      updatedAt: "x",
    },
  },
});

const render = (data: ExportPanelData, locale: "id" | "en" = "id") =>
  renderWithIntl(<ExportPanel assessmentId={ASSESSMENT} data={data} />, { locale });

beforeEach(() => {
  mocks.startExportAction.mockReset();
  mocks.job.mockReset();
  mocks.refresh.mockReset();
});
afterEach(cleanup);

describe("ExportPanel", () => {
  it("offers the first export when there is none", () => {
    render({ job: null, files: [], expired: false });
    expect(screen.getByRole("heading", { name: "Ekspor dokumen" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ekspor dokumen" })).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("lists the six documents and the ZIP as downloads with their expiry date", () => {
    render({
      job: { id: JOB, status: "succeeded", errorCode: null },
      files: ALL,
      expired: false,
    });
    const list = screen.getByRole("list", { name: "Berkas ekspor" });
    const links = within(list).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(
      ALL.map((f) => `/api/exports/${f.id}`),
    );
    expect(links[0].getAttribute("aria-label")).toBe("Unduh Naskah soal (PDF)");
    expect(links[1].getAttribute("aria-label")).toBe("Unduh Naskah soal (Word)");
    expect(links[6].getAttribute("aria-label")).toBe("Unduh semua berkas (ZIP)");
    expect(screen.getByText(/Tersedia sampai 27 November 2026/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ekspor ulang" })).toBeTruthy();
  });

  it("shows what to check: a formula written as text and the logo left out of the files, once", () => {
    render({ job: null, files: ALL, expired: false });
    expect(screen.getByText("Perlu diperiksa")).toBeTruthy();
    expect(screen.getByText("Naskah soal (Word): Soal 3: teks soal")).toBeTruthy();
    expect(screen.getAllByText(/Logo sekolah berformat SVG/)).toHaveLength(1);
    // The omission applies to the PDF as well as to Word, and the copy says so.
    expect(
      screen.getByText(
        "Logo sekolah berformat SVG tidak dapat dimuat di berkas PDF dan Word. Unggah logo PNG atau JPG di templat.",
      ),
    ).toBeTruthy();
    expect(screen.getAllByText(/Berkas logo templat tidak ditemukan/)).toHaveLength(1);
  });

  it("lists a formula too wide for the page apart from the ones written as text (I7)", () => {
    const files = ALL.map((entry) =>
      entry.id === "key-pdf"
        ? {
            ...entry,
            warnings: [
              {
                code: "mathTooWide" as const,
                where: { part: "step" as const, number: 2, step: 1 },
              },
            ],
          }
        : entry,
    );
    render({ job: null, files, expired: false });
    expect(screen.getByText(/Rumus berikut lebih lebar dari halaman/)).toBeTruthy();
    expect(screen.getByText("Kunci jawaban (PDF): Soal 2: langkah 1")).toBeTruthy();
    // The formula written as text stays under its own hint.
    expect(screen.getByText(/tidak dapat dijadikan persamaan/)).toBeTruthy();
  });

  it("says when the files have expired and offers a new export instead of links", () => {
    render({ job: null, files: ALL, expired: true });
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/sudah kedaluwarsa/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ekspor ulang" })).toBeTruthy();
  });

  it("starts the export, follows the job in a live region and refreshes once it is done", async () => {
    const user = userEvent.setup();
    mocks.startExportAction.mockResolvedValue({ ok: true, jobId: JOB });
    mocks.job.mockReturnValue(jobState("running"));
    const view = render({ job: null, files: [], expired: false });
    await user.click(screen.getByRole("button", { name: "Ekspor dokumen" }));
    expect(mocks.startExportAction).toHaveBeenCalledWith({ assessmentId: ASSESSMENT });
    const status = await screen.findByRole("status");
    await waitFor(() => {
      expect(status.textContent).toMatch(/Membuat dokumen/);
    });
    expect(document.activeElement).toBe(status);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Ekspor dokumen" }).disabled,
    ).toBe(true);

    mocks.job.mockReturnValue(jobState("succeeded"));
    view.rerender(
      <ExportPanel
        assessmentId={ASSESSMENT}
        data={{ job: null, files: [], expired: false }}
      />,
    );
    await waitFor(() => {
      expect(mocks.refresh).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole("status").textContent).toBe("Dokumen siap diunduh.");
  });

  it.each([
    ["signed-out", /Sesi Anda berakhir/],
    ["not-found", /Ekspor gagal/],
  ])("leaves the waiting state when the status poll answers %s", async (kind, text) => {
    const user = userEvent.setup();
    mocks.startExportAction.mockResolvedValue({ ok: true, jobId: JOB });
    mocks.job.mockReturnValue({ data: { kind } });
    render({ job: null, files: [], expired: false });
    await user.click(screen.getByRole("button", { name: "Ekspor dokumen" }));
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toMatch(text);
    });
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Ekspor dokumen" }).disabled,
    ).toBe(false);
  });

  it("says a deferred export waits for its turn, not for a PDF server", () => {
    mocks.job.mockReturnValue(jobState("deferred"));
    render({
      job: { id: JOB, status: "deferred", errorCode: null },
      files: [],
      expired: false,
    });
    expect(screen.getByRole("status").textContent).toBe(
      "Ekspor menunggu giliran dan berlanjut sebentar lagi.",
    );
    cleanup();
    render(
      {
        job: { id: JOB, status: "deferred", errorCode: null },
        files: [],
        expired: false,
      },
      "en",
    );
    expect(screen.getByRole("status").textContent).toBe(
      "The export is waiting for its turn and continues shortly.",
    );
  });

  it("follows a job that was already running when the page loaded", () => {
    mocks.job.mockReturnValue(jobState("queued"));
    render({
      job: { id: JOB, status: "queued", errorCode: null },
      files: ALL,
      expired: false,
    });
    expect(screen.getByRole("status").textContent).toMatch(/menunggu giliran/);
    // The old files are hidden while a new export runs.
    expect(screen.queryByRole("link")).toBeNull();
  });

  it.each([
    ["export_too_large", /terlalu besar/],
    ["export_renderer_unavailable", /Pencetak PDF/],
    ["export_stale", /berubah setelah disetujui/],
    ["something_else", /Ekspor gagal/],
  ])("explains a failed export (%s)", (code, text) => {
    render({
      job: { id: JOB, status: "failed", errorCode: code },
      files: [],
      expired: false,
    });
    expect(screen.getByRole("status").textContent).toMatch(text);
  });

  it("explains the hourly limit with the time the next export is possible", async () => {
    const user = userEvent.setup();
    mocks.startExportAction.mockResolvedValue({
      ok: false,
      reason: "hourlyLimit",
      limit: 10,
      resetsAt: "2026-11-20T04:30:00.000Z",
    });
    render({ job: null, files: [], expired: false });
    await user.click(screen.getByRole("button", { name: "Ekspor dokumen" }));
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toMatch(
        /Batas 10 ekspor per jam sudah tercapai\. Coba lagi setelah pukul 11[.:]30/,
      );
    });
  });

  it("reads in English without Indonesian words", () => {
    render(
      {
        job: { id: JOB, status: "succeeded", errorCode: null },
        files: ALL,
        expired: false,
      },
      "en",
    );
    expect(screen.getByRole("heading", { name: "Export documents" })).toBeTruthy();
    expect(
      screen.getByText("Question paper (Word): Question 3: question text"),
    ).toBeTruthy();
    expect(screen.queryByText(/Naskah|Unduh/)).toBeNull();
  });
});
