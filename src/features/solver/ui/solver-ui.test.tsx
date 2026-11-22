// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/test/intl";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  solveText: vi.fn(),
  startPhoto: vi.fn(),
  finalizePhoto: vi.fn(),
  confirm: vi.fn(),
  solveAgain: vi.fn(),
  alternative: vi.fn(),
  putFile: vi.fn(),
  jobStatus: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("../actions/solver", () => ({
  solveTextAction: mocks.solveText,
  startPhotoAction: mocks.startPhoto,
  finalizePhotoAction: mocks.finalizePhoto,
  confirmExtractionAction: mocks.confirm,
  solveAgainAction: mocks.solveAgain,
  requestAlternativeAction: mocks.alternative,
}));
vi.mock("@/features/materials/ui/put-file", () => ({ putFile: mocks.putFile }));
vi.mock("@/lib/jobs/client/use-job-status", () => ({ useJobStatus: mocks.jobStatus }));

import type { RecentSession, SessionView } from "../service/sessions";
import { ExtractionConfirm } from "./ExtractionConfirm";
import { RecentSessions } from "./RecentSessions";
import { SolutionView } from "./SolutionView";
import { SolverInput } from "./SolverInput";

const SESSION = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.jobStatus.mockReturnValue({ data: undefined, isError: false });
});
afterEach(cleanup);

function view(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: SESSION,
    inputKind: "text",
    state: "solved",
    problemMd: "Hitung $\\frac{1}{4} + \\frac{1}{4}$.",
    extractedMd: null,
    issues: [],
    hasPhoto: false,
    createdAt: "2026-11-20T03:00:00.000Z",
    solutions: [
      {
        id: "s1",
        methodLabel: "Penjumlahan pecahan",
        isAlternative: false,
        steps: [
          { title: "Samakan penyebut", bodyMd: "$\\frac{2}{4}$" },
          { title: null, bodyMd: "Sederhanakan menjadi $\\frac{1}{2}$." },
        ],
        finalAnswer: { value: "0,5", unit: "bagian", rounding: null },
        verificationStatus: "terverifikasi",
        answerChecked: true,
        crossCheck: "agree",
        crossCheckAnswer: "0.5",
      },
    ],
    jobId: null,
    working: null,
    failureCode: null,
    alternativeFailed: false,
    canSolveAgain: false,
    canAlternative: true,
    ...overrides,
  };
}

describe("SolverInput", () => {
  it("previews the typed problem with KaTeX and solves it as the teacher", async () => {
    const user = userEvent.setup();
    mocks.solveText.mockResolvedValue({ ok: true, sessionId: SESSION });
    const { container } = renderWithIntl(<SolverInput solvesLeft={28} visionLeft={25} />);
    expect(screen.getByText("28 dari 30 penyelesaian tersisa hari ini")).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Ketik soal" }).getAttribute("aria-selected"),
    ).toBe("true");
    await user.type(screen.getByLabelText("Teks soal"), "Hitung $x^2$");
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(screen.getByText("12 dari 4000 karakter")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Selesaikan dan periksa" }));
    expect(mocks.solveText).toHaveBeenCalledWith({ text: "Hitung $x^2$" });
    expect(mocks.push).toHaveBeenCalledWith(`/solve/${SESSION}`);
  });

  it("says why a solve was refused, and refuses an empty problem before any request", async () => {
    const user = userEvent.setup();
    renderWithIntl(<SolverInput solvesLeft={3} visionLeft={25} />);
    await user.click(screen.getByRole("button", { name: "Selesaikan dan periksa" }));
    expect(screen.getByRole("alert").textContent).toBe("Tulis soalnya dulu.");
    expect(mocks.solveText).not.toHaveBeenCalled();
    mocks.solveText.mockResolvedValue({ ok: false, error: "limit" });
    await user.type(screen.getByLabelText("Teks soal"), "1+1");
    await user.click(screen.getByRole("button", { name: "Selesaikan dan periksa" }));
    expect(screen.getByRole("alert").textContent).toBe(
      "Jatah 30 penyelesaian hari ini sudah habis. Coba lagi besok.",
    );
  });

  it("offers the camera and the gallery, uploads the photo with a signed PUT, then reads it", async () => {
    const user = userEvent.setup();
    mocks.startPhoto.mockResolvedValue({
      ok: true,
      sessionId: SESSION,
      uploadUrl: "https://upload.example/x",
    });
    mocks.putFile.mockResolvedValue(true);
    mocks.finalizePhoto.mockResolvedValue({ ok: true, jobId: "j" });
    renderWithIntl(<SolverInput solvesLeft={5} visionLeft={7} />);
    await user.click(screen.getByRole("tab", { name: "Foto atau gambar" }));
    expect(
      screen.getByText("7 dari 25 pembacaan gambar tersisa hari ini (OCR dan foto soal)"),
    ).toBeTruthy();
    const camera = screen.getByLabelText<HTMLInputElement>("Ambil foto");
    expect(camera.getAttribute("capture")).toBe("environment");
    expect(camera.accept).toBe("image/jpeg,image/png");
    expect(screen.getByText("Ambil foto").closest("label")?.className).toContain(
      "min-h-11",
    );
    const photo = new File([new Uint8Array(10)], "soal.jpg", { type: "image/jpeg" });
    await user.upload(camera, photo);
    expect(screen.getByText("Dipilih: soal.jpg")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Baca soal dari foto" }));
    expect(mocks.startPhoto).toHaveBeenCalledWith({
      kind: "photo",
      mime: "image/jpeg",
      size: 10,
    });
    expect(mocks.putFile).toHaveBeenCalledWith(
      "https://upload.example/x",
      photo,
      "image/jpeg",
      expect.any(Function),
    );
    expect(mocks.finalizePhoto).toHaveBeenCalledWith({ sessionId: SESSION });
    expect(mocks.push).toHaveBeenCalledWith(`/solve/${SESSION}`);
  });

  it("refuses a file that is not PNG or JPG, and a failed upload, with an alert", async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderWithIntl(<SolverInput solvesLeft={5} visionLeft={7} />);
    await user.click(screen.getByRole("tab", { name: "Foto atau gambar" }));
    await user.upload(
      screen.getByLabelText("Pilih gambar"),
      new File(["<html>"], "soal.html", { type: "text/html" }),
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "Berkas ini bukan gambar PNG atau JPG.",
    );
    mocks.startPhoto.mockResolvedValue({ ok: true, sessionId: SESSION, uploadUrl: "u" });
    mocks.putFile.mockResolvedValue(false);
    await user.upload(
      screen.getByLabelText("Pilih gambar"),
      new File([new Uint8Array(4)], "a.png", { type: "image/png" }),
    );
    await user.click(screen.getByRole("button", { name: "Baca soal dari foto" }));
    expect(screen.getByRole("alert").textContent).toBe("Foto gagal diunggah. Coba lagi.");
    expect(mocks.finalizePhoto).not.toHaveBeenCalled();
  });

  it("disables solving when nothing is left today", () => {
    renderWithIntl(<SolverInput solvesLeft={0} visionLeft={25} />);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Selesaikan dan periksa" })
        .disabled,
    ).toBe(true);
  });
});

describe("ExtractionConfirm", () => {
  it("shows the photo beside the editable reading and lists what is uncertain", async () => {
    const user = userEvent.setup();
    mocks.confirm.mockResolvedValueOnce({ ok: false, error: "markers" });
    renderWithIntl(
      <ExtractionConfirm
        sessionId={SESSION}
        extractedMd="Hitung [[?]]$\frac{3}{4}$[[?]] dari 20."
        issues={[
          { kind: "uncertain", text: "$\\frac{3}{4}$" },
          { kind: "katex", text: "$\\frac{3}{$" },
        ]}
        hasPhoto
        readingFailed={false}
      />,
    );
    expect(screen.getByRole("img", { name: "Foto soal" }).getAttribute("src")).toBe(
      `/api/solve/${SESSION}/photo`,
    );
    expect(screen.getByText("Belum pasti terbaca: $\\frac{3}{4}$")).toBeTruthy();
    expect(screen.getByText("Rumus tidak dapat ditampilkan: $\\frac{3}{$")).toBeTruthy();
    const box = screen.getByLabelText<HTMLTextAreaElement>("Teks soal");
    await user.click(screen.getByRole("button", { name: "Konfirmasi dan selesaikan" }));
    expect(screen.getByRole("alert").textContent).toBe(
      "Masih ada bagian bertanda [[?]]. Perbaiki bagian itu, lalu hapus tandanya.",
    );
    await user.clear(box);
    await user.type(box, "Hitung 3/4 dari 20.");
    mocks.confirm.mockResolvedValueOnce({ ok: true, jobId: "j" });
    await user.click(screen.getByRole("button", { name: "Konfirmasi dan selesaikan" }));
    expect(mocks.confirm).toHaveBeenLastCalledWith({
      sessionId: SESSION,
      text: "Hitung 3/4 dari 20.",
    });
    expect(mocks.refresh).toHaveBeenCalled();
  });
});

describe("SolutionView", () => {
  it("shows the method, the verification badge, the final answer with units and rounding, and the steps", () => {
    renderWithIntl(<SolutionView session={view()} />);
    const card = screen.getByRole("article", { name: "Metode 1: Penjumlahan pecahan" });
    expect(within(card).getByText("Terverifikasi otomatis")).toBeTruthy();
    expect(within(card).getByText("Jawaban akhir")).toBeTruthy();
    expect(within(card).getByText("bagian")).toBeTruthy();
    expect(within(card).getByText("Tanpa pembulatan")).toBeTruthy();
    const steps = within(card).getByText("Langkah penyelesaian (2)");
    expect(steps.closest("details")?.open).toBe(true);
    expect(within(card).getByText("Samakan penyebut")).toBeTruthy();
    expect(screen.queryByText(/belum dihitung ulang/)).toBeNull();
  });

  it("never shows an unchecked answer as verified", () => {
    const session = view();
    session.solutions[0] = {
      ...session.solutions[0],
      verificationStatus: "belum_dapat_diverifikasi",
      answerChecked: false,
      finalAnswer: { value: "42", unit: null, rounding: "dibulatkan ke satuan" },
    };
    renderWithIntl(<SolutionView session={session} />);
    expect(screen.getByText("Belum dapat diverifikasi")).toBeTruthy();
    expect(screen.queryByText("Terverifikasi otomatis")).toBeNull();
    expect(
      screen.getByText("Jawaban akhir ini belum dihitung ulang oleh mesin."),
    ).toBeTruthy();
    expect(screen.getByText("Pembulatan: dibulatkan ke satuan")).toBeTruthy();
  });

  it("asks for another method and follows its run in the live region", async () => {
    const user = userEvent.setup();
    mocks.alternative.mockResolvedValue({ ok: true, jobId: "job-2" });
    mocks.jobStatus.mockImplementation((jobId: string | null) =>
      jobId === "job-2"
        ? {
            data: {
              kind: "ok",
              job: { id: "job-2", status: "running", type: "alternative_method" },
            },
            isError: false,
          }
        : { data: undefined, isError: false },
    );
    renderWithIntl(<SolutionView session={view()} />);
    await user.click(screen.getByRole("button", { name: "Tampilkan metode lain" }));
    expect(mocks.alternative).toHaveBeenCalledWith({ sessionId: SESSION });
    const statuses = screen.getAllByRole("status");
    expect(statuses.some((node) => node.textContent === "Mencari metode lain…")).toBe(
      true,
    );
    expect(screen.queryByRole("button", { name: "Tampilkan metode lain" })).toBeNull();
  });

  it("refreshes the page once the followed run has finished", () => {
    mocks.jobStatus.mockReturnValue({
      data: {
        kind: "ok",
        job: { id: "job-1", status: "succeeded", type: "solve_problem" },
      },
      isError: false,
    });
    renderWithIntl(
      <SolutionView
        session={view({
          state: "solving",
          solutions: [],
          jobId: "job-1",
          working: "solve",
        })}
      />,
    );
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("holds an uncertain reading for confirmation instead of a solution (SOL-02)", () => {
    renderWithIntl(
      <SolutionView
        session={view({
          inputKind: "photo",
          state: "confirm",
          problemMd: null,
          extractedMd: "Hitung [[?]]x[[?]]",
          issues: [{ kind: "uncertain", text: "x" }],
          solutions: [],
          canAlternative: false,
        })}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Periksa hasil bacaan foto" }),
    ).toBeTruthy();
    expect(screen.queryByRole("article")).toBeNull();
  });

  it("offers to solve again after a failed run", async () => {
    const user = userEvent.setup();
    mocks.solveAgain.mockResolvedValue({ ok: false, error: "limit" });
    renderWithIntl(
      <SolutionView
        session={view({
          state: "failed",
          solutions: [],
          canSolveAgain: true,
          canAlternative: false,
        })}
      />,
    );
    expect(screen.getByText("Soal ini belum dapat diselesaikan.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Selesaikan lagi" }));
    expect(mocks.solveAgain).toHaveBeenCalledWith({ sessionId: SESSION });
    expect(
      screen.getAllByRole("alert").some((node) => node.textContent.includes("Jatah 30")),
    ).toBe(true);
  });
});

describe("SolutionView, the cross-check (R26)", () => {
  const withCheck = (
    crossCheck: "pending" | "agree" | "disagree" | "unavailable",
    status:
      "terverifikasi" | "dicek_silang" | "belum_dapat_diverifikasi" | "ketidaksesuaian",
    extra: Partial<SessionView> = {},
  ) => {
    const session = view(extra);
    session.solutions[0] = {
      ...session.solutions[0],
      verificationStatus: status,
      crossCheck,
      crossCheckAnswer: crossCheck === "disagree" ? "0.5" : null,
    };
    return session;
  };

  it("shows a disagreeing cross-check prominently, with the other answer", () => {
    renderWithIntl(<SolutionView session={withCheck("disagree", "ketidaksesuaian")} />);
    expect(screen.getByText("Ditemukan ketidaksesuaian")).toBeTruthy();
    const alert = screen
      .getAllByRole("alert")
      .find((node) => node.textContent.includes("0.5"));
    expect(alert?.textContent).toBe(
      "Penyelesaian AI kedua yang dikerjakan terpisah mendapat jawaban 0.5. Periksa langkahnya sebelum memakai jawaban ini.",
    );
  });

  it("shows the solution as being checked while the cross-check runs", () => {
    renderWithIntl(
      <SolutionView
        session={withCheck("pending", "belum_dapat_diverifikasi", {
          jobId: "job-1",
          working: "solve",
        })}
      />,
    );
    expect(screen.getByText("Sedang diperiksa")).toBeTruthy();
    expect(screen.queryByText("Belum dapat diverifikasi")).toBeNull();
  });

  it("says when the cross-check could not run", () => {
    renderWithIntl(
      <SolutionView session={withCheck("unavailable", "belum_dapat_diverifikasi")} />,
    );
    expect(screen.getByText("Belum dapat diverifikasi")).toBeTruthy();
    expect(
      screen.getByText("Pemeriksaan silang oleh AI kedua tidak dapat dijalankan."),
    ).toBeTruthy();
  });
});

describe("RecentSessions", () => {
  it("links each recent session with its excerpt, input and status", () => {
    const sessions: RecentSession[] = [
      {
        id: SESSION,
        inputKind: "photo",
        status: "solved",
        excerptMd: "Hitung $x$",
        createdAt: "2026-11-20T03:00:00.000Z",
        verificationStatus: "terverifikasi",
      },
    ];
    renderWithIntl(<RecentSessions sessions={sessions} currentId={SESSION} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(`/solve/${SESSION}`);
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(link.textContent).toContain("Dari foto");
    expect(link.textContent).toContain("Selesai");
    expect(link.textContent).toContain("Terverifikasi otomatis");
  });

  it("says when there is nothing yet", () => {
    renderWithIntl(<RecentSessions sessions={[]} />);
    expect(screen.getByText("Belum ada soal yang diselesaikan.")).toBeTruthy();
  });
});

describe("SolverInput, the vision cap (R28)", () => {
  it("disables reading a photo when no vision read is left today, and says why", async () => {
    const user = userEvent.setup();
    renderWithIntl(<SolverInput solvesLeft={10} visionLeft={0} />);
    await user.click(screen.getByRole("tab", { name: "Foto atau gambar" }));
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Baca soal dari foto" })
        .disabled,
    ).toBe(true);
    expect(
      screen.getByText(
        "Jatah 25 pembacaan gambar hari ini sudah habis (OCR dan foto soal bersama). Coba lagi besok.",
      ),
    ).toBeTruthy();
  });
});
