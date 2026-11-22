// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/test/intl";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  finalize: vi.fn(),
  cancel: vi.fn(),
  put: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("../actions/start-upload", () => ({ startUploadAction: mocks.start }));
vi.mock("./finalize-request", () => ({ requestFinalize: mocks.finalize }));
vi.mock("../actions/cancel-upload", () => ({ cancelUploadAction: mocks.cancel }));
vi.mock("./put-file", () => ({ putFile: mocks.put }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));

import { UploadDropzone } from "./UploadDropzone";

const KEY = "materials/u/m/source.pdf";
const pdf = (name = "Buku guru.pdf", size = 4) =>
  new File([new Uint8Array(size)], name, { type: "application/pdf" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.start.mockResolvedValue({
    ok: true,
    uploadUrl: "/api/dev/upload?key=x",
    objectKey: KEY,
    contentType: "application/pdf",
  });
  mocks.put.mockImplementation(
    (_url: string, _file: File, _type: string, onProgress: (p: number) => void) => {
      onProgress(50);
      onProgress(100);
      return Promise.resolve(true);
    },
  );
  mocks.finalize.mockResolvedValue({ ok: true, materialId: "m" });
  mocks.cancel.mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
});

describe("UploadDropzone", () => {
  it("shows the privacy notice, the storage meter and labelled inputs (file and camera)", () => {
    renderWithIntl(<UploadDropzone usedBytes={300 * 1024 * 1024} />);
    expect(screen.getByText(/data pribadi siswa/)).toBeTruthy();
    expect(screen.getByText(/300 MB dari 1 GB terpakai/)).toBeTruthy();
    const file = screen.getByLabelText("Pilih berkas");
    expect(file.getAttribute("type")).toBe("file");
    expect(file.getAttribute("accept")).toContain(".docx");
    expect(file.getAttribute("accept")).toContain("application/pdf");
    const camera = screen.getByLabelText("Ambil foto");
    expect(camera.getAttribute("capture")).toBe("environment");
    expect(camera.getAttribute("accept")).toBe("image/jpeg,image/png");
  });

  it("refuses a .doc and an oversized file before asking for a URL", async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderWithIntl(<UploadDropzone usedBytes={0} />);
    await user.upload(
      screen.getByLabelText("Pilih berkas"),
      new File(["x"], "lama.doc", { type: "application/msword" }),
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /simpan sebagai \.docx/,
    );
    await user.upload(
      screen.getByLabelText("Pilih berkas"),
      pdf("besar.pdf", 50 * 1024 * 1024 + 1),
    );
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/50 MB/);
    });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("uploads with progress to the signed URL, then finalises with the file's title", async () => {
    const user = userEvent.setup();
    renderWithIntl(<UploadDropzone usedBytes={0} folderId="f1" />);
    const file = pdf();
    await user.upload(screen.getByLabelText("Pilih berkas"), file);
    expect(await screen.findByText(/Buku guru\.pdf tersimpan/)).toBeTruthy();
    expect(mocks.start).toHaveBeenCalledWith({
      fileName: "Buku guru.pdf",
      declaredType: "application/pdf",
      size: 4,
    });
    expect(mocks.put.mock.calls[0].slice(0, 3)).toEqual([
      "/api/dev/upload?key=x",
      file,
      "application/pdf",
    ]);
    expect(mocks.finalize).toHaveBeenCalledWith({
      objectKey: KEY,
      title: "Buku guru",
      folderId: "f1",
    });
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
    expect(screen.getByRole("status").textContent).toMatch(/tersimpan/);
    // The new material shows in the list.
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("shows the typed reason a finalise refused, and a network failure", async () => {
    const user = userEvent.setup();
    mocks.finalize.mockResolvedValue({ ok: false, error: "encrypted" });
    renderWithIntl(<UploadDropzone usedBytes={0} />);
    await user.upload(screen.getByLabelText("Pilih berkas"), pdf("rahasia.pdf"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/terkunci kata sandi/);

    cleanup();
    mocks.put.mockResolvedValue(false);
    renderWithIntl(<UploadDropzone usedBytes={0} />, { locale: "en" });
    await user.upload(screen.getByLabelText("Choose file"), pdf("buku.pdf"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/connection dropped/);
    expect(mocks.finalize).toHaveBeenCalledTimes(1);
  });

  it("retries a busy server by itself before asking the teacher (R31)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      mocks.finalize
        .mockResolvedValueOnce({ ok: false, error: "busy" })
        .mockResolvedValueOnce({ ok: false, error: "busy" })
        .mockResolvedValue({ ok: true, materialId: "m" });
      renderWithIntl(<UploadDropzone usedBytes={0} />);
      await user.upload(screen.getByLabelText("Pilih berkas"), pdf("buku.pdf"));
      await vi.advanceTimersByTimeAsync(25_000);
      await waitFor(() => {
        expect(mocks.finalize).toHaveBeenCalledTimes(3);
      });
      expect(screen.queryByRole("alert")).toBeNull();
      // The file went up once: only finalise was repeated.
      expect(mocks.put).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the busy message once the automatic retries are used up", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      mocks.finalize.mockResolvedValue({ ok: false, error: "busy" });
      renderWithIntl(<UploadDropzone usedBytes={0} />);
      await user.upload(screen.getByLabelText("Pilih berkas"), pdf("buku.pdf"));
      await vi.advanceTimersByTimeAsync(30_000);
      await waitFor(() => {
        expect(mocks.finalize).toHaveBeenCalledTimes(4);
      });
      expect((await screen.findByRole("alert")).textContent).toMatch(
        /membaca berkas lain/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("announces progress in steps of 10% while the bar shows the exact value", async () => {
    const user = userEvent.setup();
    let release: (sent: boolean) => void = () => undefined;
    mocks.put.mockImplementation(
      (_url: string, _file: File, _type: string, onProgress: (p: number) => void) => {
        onProgress(5);
        onProgress(15);
        onProgress(23);
        return new Promise<boolean>((resolve) => {
          release = resolve;
        });
      },
    );
    renderWithIntl(<UploadDropzone usedBytes={0} />);
    await user.upload(screen.getByLabelText("Pilih berkas"), pdf());
    await waitFor(() => {
      expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("23");
    });
    expect(screen.getByRole("status").textContent).toMatch(/20%/);
    release(true);
    expect(await screen.findByText(/tersimpan/)).toBeTruthy();
  });

  it("cancels: aborts the transfer, frees the reservation and removes the row", async () => {
    const user = userEvent.setup();
    mocks.put.mockImplementation(
      (
        _url: string,
        _file: File,
        _type: string,
        _onProgress: unknown,
        signal: AbortSignal,
      ) =>
        new Promise<boolean>((resolve) => {
          signal.addEventListener("abort", () => {
            resolve(false);
          });
        }),
    );
    renderWithIntl(<UploadDropzone usedBytes={0} />);
    await user.upload(screen.getByLabelText("Pilih berkas"), pdf());
    await user.click(await screen.findByRole("button", { name: "Batal" }));
    await waitFor(() => {
      expect(mocks.cancel).toHaveBeenCalledWith({ objectKey: KEY });
    });
    await waitFor(() => {
      expect(screen.queryByRole("progressbar")).toBeNull();
    });
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it("retries with the same reservation when the file had not arrived", async () => {
    const user = userEvent.setup();
    mocks.finalize
      .mockResolvedValueOnce({ ok: false, error: "missing" })
      .mockResolvedValueOnce({ ok: true, materialId: "m" });
    renderWithIntl(<UploadDropzone usedBytes={0} />);
    await user.upload(screen.getByLabelText("Pilih berkas"), pdf());
    await user.click(await screen.findByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByText(/tersimpan/)).toBeTruthy();
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.put).toHaveBeenCalledTimes(2);
    expect(mocks.finalize).toHaveBeenCalledTimes(2);
  });
});
