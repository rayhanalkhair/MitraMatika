// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/test/intl";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  loadPdf: vi.fn(),
  release: vi.fn(),
  drawPdfPage: vi.fn(),
  renderPdfPagePng: vi.fn(),
  renderImagePng: vi.fn(),
  prepare: vi.fn(),
  queue: vi.fn(),
  save: vi.fn(),
  put: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
// The stub stands in for pdfjs-dist: the browser-side renderer of PDF pages.
vi.mock("./pdf-render", () => ({
  acquirePdf: (url: string) => ({
    pdf: mocks.loadPdf(url) as Promise<unknown>,
    release: mocks.release,
  }),
  drawPdfPage: mocks.drawPdfPage,
  renderPdfPagePng: mocks.renderPdfPagePng,
  renderImagePng: mocks.renderImagePng,
}));
vi.mock("../actions/ocr", () => ({
  prepareOcrUploadsAction: mocks.prepare,
  queueOcrAction: mocks.queue,
  savePageTextAction: mocks.save,
}));
vi.mock("./put-file", () => ({ putFile: mocks.put }));

import { OcrReview, markedParts, type ReviewPageView } from "./OcrReview";
import { OcrSelector } from "./OcrSelector";
import { PageViewer } from "./PageViewer";

const ID = "11111111-1111-4111-8111-111111111111";
const PDF = { numPages: 5 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadPdf.mockResolvedValue(PDF);
  mocks.drawPdfPage.mockResolvedValue(undefined);
  mocks.renderPdfPagePng.mockImplementation((_pdf: unknown, pageNo: number) =>
    Promise.resolve({
      png: new Blob([new Uint8Array(100 + pageNo)], { type: "image/png" }),
      blank: false,
    }),
  );
  mocks.put.mockResolvedValue(true);
});
afterEach(cleanup);

describe("PageViewer", () => {
  it("renders a PDF page in the browser from the owner-checked file route", async () => {
    const view = renderWithIntl(<PageViewer materialId={ID} kind="pdf" pageNo={3} />);
    expect(screen.getByRole("status").textContent).toBe("Memuat gambar halaman…");
    await waitFor(() => {
      expect(mocks.drawPdfPage).toHaveBeenCalledTimes(1);
    });
    expect(mocks.loadPdf).toHaveBeenCalledWith(`/api/materials/${ID}/file`);
    const [pdf, pageNo, canvas] = mocks.drawPdfPage.mock.calls[0] as [
      unknown,
      number,
      HTMLCanvasElement,
    ];
    expect(pdf).toBe(PDF);
    expect(pageNo).toBe(3);
    expect(canvas.tagName).toBe("CANVAS");
    await waitFor(() => {
      expect(screen.queryByRole("status")).toBeNull();
    });
    expect(screen.getByRole("img", { name: "Gambar halaman 3" })).toBe(canvas);

    // Another page: drawn again; the first page's hold on the shared document is released
    // (pdf-render.test.tsx proves the document itself is kept).
    view.rerender(<PageViewer materialId={ID} kind="pdf" pageNo={4} />);
    await waitFor(() => {
      expect(mocks.drawPdfPage).toHaveBeenCalledTimes(2);
    });
    expect(mocks.drawPdfPage.mock.calls[1][1]).toBe(4);
    expect(mocks.release).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });

  it("says so when the PDF cannot be loaded", async () => {
    mocks.loadPdf.mockRejectedValue(new Error("404"));
    renderWithIntl(<PageViewer materialId={ID} kind="pdf" pageNo={1} />);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Gambar halaman tidak dapat dimuat. Muat ulang halaman ini.",
    );
  });

  it("shows an image material from its file and explains a Word document", () => {
    renderWithIntl(<PageViewer materialId={ID} kind="image" pageNo={1} />);
    const image = screen.getByRole("img", { name: "Gambar halaman 1" });
    expect(image.getAttribute("src")).toBe(`/api/materials/${ID}/file`);
    cleanup();
    renderWithIntl(<PageViewer materialId={ID} kind="docx" pageNo={1} />);
    expect(screen.getByText("Dokumen Word tidak punya gambar halaman.")).toBeTruthy();
    expect(mocks.loadPdf).not.toHaveBeenCalled();
  });
});

describe("OcrSelector", () => {
  const PAGES = [
    { pageNo: 1, ocrStatus: "available", textSource: null },
    { pageNo: 2, ocrStatus: "done", textSource: "ocr" },
    { pageNo: 3, ocrStatus: "failed", textSource: null },
    { pageNo: 4, ocrStatus: "queued", textSource: null },
    { pageNo: 5, ocrStatus: "none", textSource: "pdf_text" },
  ];

  it("shows the pages left today and offers only pages that can be OCR'd", () => {
    renderWithIntl(
      <OcrSelector
        materialId={ID}
        kind="pdf"
        sizeBytes={1000}
        pages={PAGES}
        left={18}
        visionLeft={21}
      />,
    );
    expect(screen.getByText("18 dari 20 halaman tersisa hari ini")).toBeTruthy();
    // R28: OCR pages and photo reads share one daily vision cap.
    expect(
      screen.getByText(
        "21 dari 25 pembacaan gambar tersisa hari ini (OCR dan foto soal)",
      ),
    ).toBeTruthy();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.map((box) => box.closest("label")?.textContent)).toEqual([
      "Halaman 1",
      "Halaman 3",
    ]);
  });

  it("renders and uploads the chosen PDF pages as PNG, then queues them", async () => {
    mocks.prepare.mockResolvedValue({
      ok: true,
      uploads: [
        { pageNo: 1, url: "/up/1" },
        { pageNo: 3, url: "/up/3" },
      ],
      left: 18,
    });
    mocks.queue.mockResolvedValue({ ok: true, left: 16, jobId: "j" });
    const user = userEvent.setup();
    renderWithIntl(
      <OcrSelector
        materialId={ID}
        kind="pdf"
        sizeBytes={1000}
        pages={PAGES}
        left={18}
        visionLeft={21}
      />,
    );
    await user.click(screen.getByLabelText("Halaman 3"));
    await user.click(screen.getByLabelText("Halaman 1"));
    await user.click(screen.getByRole("button", { name: "OCR halaman terpilih" }));

    await waitFor(() => {
      expect(mocks.queue).toHaveBeenCalledWith({ materialId: ID, pageNos: [1, 3] });
    });
    expect(mocks.loadPdf).toHaveBeenCalledWith(`/api/materials/${ID}/file`);
    expect(
      (mocks.renderPdfPagePng.mock.calls as [unknown, number][]).map((call) => call[1]),
    ).toEqual([1, 3]);
    expect(mocks.prepare).toHaveBeenCalledWith({
      materialId: ID,
      pages: [
        { pageNo: 1, size: 101 },
        { pageNo: 3, size: 103 },
      ],
    });
    expect(
      (mocks.put.mock.calls as [string, File, string][]).map((call) => [
        call[0],
        call[2],
      ]),
    ).toEqual([
      ["/up/1", "image/png"],
      ["/up/3", "image/png"],
    ]);
    // Uploads happen before the pages are queued.
    expect(mocks.put.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.queue.mock.invocationCallOrder[0],
    );
    expect(await screen.findByText("2 halaman masuk antrean OCR.")).toBeTruthy();
    expect(screen.getByText("16 dari 20 halaman tersisa hari ini")).toBeTruthy();
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("does not queue when an upload fails or the cap is reached", async () => {
    mocks.prepare.mockResolvedValue({
      ok: true,
      uploads: [{ pageNo: 1, url: "/up/1" }],
      left: 18,
    });
    mocks.put.mockResolvedValue(false);
    const user = userEvent.setup();
    renderWithIntl(
      <OcrSelector
        materialId={ID}
        kind="pdf"
        sizeBytes={1000}
        pages={PAGES}
        left={18}
        visionLeft={21}
      />,
    );
    await user.click(screen.getByLabelText("Halaman 1"));
    await user.click(screen.getByRole("button", { name: "OCR halaman terpilih" }));
    expect(
      await screen.findByText("Gambar halaman gagal diunggah. Coba lagi."),
    ).toBeTruthy();
    expect(mocks.queue).not.toHaveBeenCalled();

    mocks.prepare.mockResolvedValue({ ok: false, error: "limit" });
    await user.click(screen.getByRole("button", { name: "OCR halaman terpilih" }));
    expect(
      await screen.findByText(
        "Sisa batas OCR hari ini tidak cukup untuk halaman yang dipilih.",
      ),
    ).toBeTruthy();
    expect(mocks.queue).not.toHaveBeenCalled();
  });

  it("refuses more pages than are left without any work", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <OcrSelector
        materialId={ID}
        kind="pdf"
        sizeBytes={1000}
        pages={PAGES}
        left={1}
        visionLeft={25}
      />,
    );
    await user.click(screen.getByLabelText("Halaman 1"));
    await user.click(screen.getByLabelText("Halaman 3"));
    await user.click(screen.getByRole("button", { name: "OCR halaman terpilih" }));
    expect(
      await screen.findByText("Hari ini Anda hanya bisa memilih 1 halaman lagi."),
    ).toBeTruthy();
    expect(mocks.renderPdfPagePng).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("never uploads or queues a page that renders blank", async () => {
    mocks.renderPdfPagePng.mockImplementation((_pdf: unknown, pageNo: number) =>
      Promise.resolve({
        png: new Blob([new Uint8Array(10)], { type: "image/png" }),
        blank: pageNo === 3,
      }),
    );
    const user = userEvent.setup();
    renderWithIntl(
      <OcrSelector
        materialId={ID}
        kind="pdf"
        sizeBytes={1000}
        pages={PAGES}
        left={18}
        visionLeft={21}
      />,
    );
    await user.click(screen.getByLabelText("Halaman 1"));
    await user.click(screen.getByLabelText("Halaman 3"));
    await user.click(screen.getByRole("button", { name: "OCR halaman terpilih" }));
    expect(
      await screen.findByText(
        "Halaman 3 tampak kosong, jadi tidak dikirim ke OCR. Ketik teksnya sendiri bila perlu.",
      ),
    ).toBeTruthy();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("warns once before OCR replaces a page the teacher corrected", async () => {
    mocks.queue.mockResolvedValue({ ok: true, left: 19, jobId: "j" });
    const user = userEvent.setup();
    renderWithIntl(
      <OcrSelector
        materialId={ID}
        kind="image"
        sizeBytes={50_000}
        pages={[{ pageNo: 1, ocrStatus: "available", textSource: "manual" }]}
        left={20}
        visionLeft={25}
      />,
    );
    await user.click(screen.getByLabelText("Halaman 1"));
    const submit = screen.getByRole("button", { name: "OCR halaman terpilih" });
    await user.click(submit);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Teks halaman 1 sudah Anda perbaiki. OCR akan menggantinya. Tekan tombol OCR sekali lagi untuk melanjutkan.",
    );
    expect(mocks.queue).not.toHaveBeenCalled();
    await user.click(submit);
    await waitFor(() => {
      expect(mocks.queue).toHaveBeenCalledWith({ materialId: ID, pageNos: [1] });
    });
  });

  it("takes a new count of pages left from the server after a refresh", () => {
    const view = renderWithIntl(
      <OcrSelector
        materialId={ID}
        kind="pdf"
        sizeBytes={1000}
        pages={PAGES}
        left={18}
        visionLeft={21}
      />,
    );
    view.rerender(
      <OcrSelector
        materialId={ID}
        kind="pdf"
        sizeBytes={1000}
        pages={PAGES}
        left={20}
        visionLeft={25}
      />,
    );
    expect(screen.getByText("20 dari 20 halaman tersisa hari ini")).toBeTruthy();
  });

  it("speaks English correctly for one page", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <OcrSelector
        materialId={ID}
        kind="pdf"
        sizeBytes={1000}
        pages={PAGES}
        left={1}
        visionLeft={25}
      />,
      { locale: "en" },
    );
    await user.click(screen.getByLabelText("Page 1"));
    await user.click(screen.getByLabelText("Page 3"));
    await user.click(screen.getByRole("button", { name: "OCR selected pages" }));
    expect(
      await screen.findByText("You can only choose 1 more page today."),
    ).toBeTruthy();
  });

  it("queues a small photo straight away (its stored file is read)", async () => {
    mocks.queue.mockResolvedValue({ ok: true, left: 19, jobId: "j" });
    const user = userEvent.setup();
    renderWithIntl(
      <OcrSelector
        materialId={ID}
        kind="image"
        sizeBytes={50_000}
        pages={[{ pageNo: 1, ocrStatus: "available", textSource: null }]}
        left={20}
        visionLeft={25}
      />,
    );
    await user.click(screen.getByLabelText("Halaman 1"));
    await user.click(screen.getByRole("button", { name: "OCR halaman terpilih" }));
    await waitFor(() => {
      expect(mocks.queue).toHaveBeenCalledWith({ materialId: ID, pageNos: [1] });
    });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.renderImagePng).not.toHaveBeenCalled();
  });
});

describe("OcrReview", () => {
  const PAGE: ReviewPageView = {
    pageNo: 2,
    textMd: "Matematika untuk SMP/MTs [[?]]Kelas VII[[?]] dan $x = [[?]]4[[?]]$.",
    confidence: "medium",
    flags: ["uncertain_math", "truncated"],
    ocrStatus: "done",
    textSource: "ocr",
  };

  it("finds the marked parts of a text", () => {
    expect(markedParts(PAGE.textMd).map((part) => part.text)).toEqual(["Kelas VII", "4"]);
    expect(markedParts("tanpa tanda [[?]] tunggal")).toEqual([]);
  });

  it("gives the real reason for a flagged page that has no [[?]] marks, never an 'uncertain parts' that contradicts the marks line", () => {
    const view = renderWithIntl(
      <OcrReview
        materialId={ID}
        kind="pdf"
        total={5}
        page={{
          ...PAGE,
          textMd: "x + y = 10, x - y = 2, 2x + 3y = 12",
          confidence: "medium",
          flags: ["formula_text"],
        }}
        nextFlagged={null}
      />,
    );
    expect(
      screen.getByText(
        "Banyak simbol rumus; urutannya di teks bisa keliru, cocokkan dengan gambar halaman",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Tidak ada bagian bertanda [[?]].")).toBeTruthy();
    expect(view.container.textContent).not.toContain("Ada bagian yang tidak pasti");
  });

  it("says a page with almost no text may be a scan, not that it is 'little text'", () => {
    renderWithIntl(
      <OcrReview
        materialId={ID}
        kind="pdf"
        total={5}
        page={{ ...PAGE, textMd: "", confidence: "low", flags: ["low_text"] }}
        nextFlagged={null}
      />,
    );
    expect(screen.getByText("Halaman ini hanya berisi sedikit teks")).toBeTruthy();
  });

  it("shows the page beside its text, says 'perlu diperiksa' and never a percentage", () => {
    const view = renderWithIntl(
      <OcrReview materialId={ID} kind="pdf" total={5} page={PAGE} nextFlagged={4} />,
    );
    expect(screen.getByText("Perlu diperiksa")).toBeTruthy();
    expect(view.container.textContent).not.toMatch(/%/);
    expect(
      screen.getByText("Ada bagian bertanda [[?]] atau rumus yang tidak terbaca"),
    ).toBeTruthy();
    expect(screen.getByText("Teks terpotong, periksa akhir halaman")).toBeTruthy();
    expect(screen.getByText("Hasil OCR")).toBeTruthy();
    expect(screen.getByText("2 bagian bertanda [[?]].")).toBeTruthy();
    const marks = view.container.querySelectorAll("mark");
    expect([...marks].map((mark) => mark.textContent)).toEqual(["Kelas VII", "4"]);
    expect(
      screen
        .getByRole("link", { name: "Halaman berikutnya yang perlu diperiksa" })
        .getAttribute("href"),
    ).toBe(`/materials/${ID}?page=4#halaman`);
    expect(
      screen.getByRole("link", { name: "Halaman sebelumnya" }).getAttribute("href"),
    ).toBe(`/materials/${ID}?page=1#halaman`);
    expect(screen.getByText("Halaman 2 dari 5")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Gambar halaman 2" })).toBeTruthy();
  });

  it("jumps from one marked part to the next in the text", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <OcrReview materialId={ID} kind="pdf" total={5} page={PAGE} nextFlagged={null} />,
    );
    const area = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Teks halaman 2",
    });
    area.setSelectionRange(0, 0);
    const jump = screen.getByRole("button", { name: "Ke bagian bertanda berikutnya" });
    await user.click(jump);
    expect(area.value.slice(area.selectionStart, area.selectionEnd)).toBe(
      "[[?]]Kelas VII[[?]]",
    );
    await user.click(jump);
    expect(area.value.slice(area.selectionStart, area.selectionEnd)).toBe("[[?]]4[[?]]");
    await user.click(jump);
    expect(area.value.slice(area.selectionStart, area.selectionEnd)).toBe(
      "[[?]]Kelas VII[[?]]",
    );
  });

  it("saves the teacher's text and reports a refusal", async () => {
    mocks.save.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderWithIntl(
      <OcrReview materialId={ID} kind="pdf" total={5} page={PAGE} nextFlagged={null} />,
    );
    const area = screen.getByRole("textbox", { name: "Teks halaman 2" });
    await user.clear(area);
    await user.type(area, "Kelas VIII");
    await user.click(screen.getByRole("button", { name: "Simpan teks" }));
    expect(mocks.save).toHaveBeenCalledWith({
      materialId: ID,
      pageNo: 2,
      textMd: "Kelas VIII",
    });
    expect(await screen.findByText("Teks halaman disimpan.")).toBeTruthy();
    expect(mocks.refresh).toHaveBeenCalled();

    mocks.save.mockResolvedValue({ ok: false, error: "tooLong" });
    await user.click(screen.getByRole("button", { name: "Simpan teks" }));
    expect(
      await screen.findByText(
        "Teks terlalu panjang. Paling banyak 20000 karakter per halaman.",
      ),
    ).toBeTruthy();
  });

  it("keeps the saved notice and takes the stored text when the page refreshes", async () => {
    mocks.save.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    const view = renderWithIntl(
      <OcrReview materialId={ID} kind="pdf" total={5} page={PAGE} nextFlagged={null} />,
    );
    await user.click(screen.getByRole("button", { name: "Simpan teks" }));
    expect(await screen.findByText("Teks halaman disimpan.")).toBeTruthy();
    // The refresh after the save: same page, the text as stored.
    view.rerender(
      <OcrReview
        materialId={ID}
        kind="pdf"
        total={5}
        page={{ ...PAGE, textMd: "Kelas VIII", textSource: "manual", flags: [] }}
        nextFlagged={null}
      />,
    );
    expect(screen.getByText("Teks halaman disimpan.")).toBeTruthy();
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Teks halaman 2" }).value,
    ).toBe("Kelas VIII");
  });

  it("names each marked-part button by what it does", () => {
    renderWithIntl(
      <OcrReview materialId={ID} kind="pdf" total={5} page={PAGE} nextFlagged={null} />,
    );
    expect(
      screen.getByRole("button", { name: "Ke bagian bertanda: Kelas VII" }),
    ).toBeTruthy();
  });

  it("keeps a page queued for OCR read-only", () => {
    renderWithIntl(
      <OcrReview
        materialId={ID}
        kind="pdf"
        total={5}
        page={{ ...PAGE, ocrStatus: "queued", confidence: "high", flags: [] }}
        nextFlagged={null}
      />,
    );
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Teks halaman 2" })
        .readOnly,
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "Simpan teks" })).toBeNull();
    expect(screen.getByText("Teks jelas")).toBeTruthy();
  });
});
