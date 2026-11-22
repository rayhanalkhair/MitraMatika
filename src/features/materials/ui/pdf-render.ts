// Browser-only: PDF pages drawn with pdfjs-dist (decision 7, Ruling R3) for the page viewer, and
// the PNG of a page (or of a photo too large to send as it is) that OCR reads. Loaded with a
// dynamic import from client effects and handlers only, so the server never evaluates pdfjs.
//
// pdf.js fetches its image decoders (JBIG2, CCITT and JPEG 2000 scans), colour profile and
// standard fonts at run time; they are served from this origin under /pdfjs/<version>/
// (scripts/copy-pdfjs-assets.mjs). Without them a scanned page renders white (Task 6 review I1).
//
// One document per material is kept while anything on the page uses it (the viewer across page
// turns and saves, the OCR selector), then destroyed, which frees it in pdf.js's worker.
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { MAX_PAGE_IMAGE_BYTES, MAX_PAGE_IMAGE_SIDE } from "../schema/ocr";
import { inkShare, isBlankShare } from "../schema/page-ink";

/** The longest side of a page picture sent to OCR: sharp enough for small print. */
export const OCR_RENDER_SIDE = 2_000;
const SHRINK = 0.75;
const MAX_TRIES = 5;
/** How long an unused document is kept (a page turn remounts the viewer within this). */
export const RELEASE_GRACE_MS = 30_000;

let workerReady = false;

async function pdfjs() {
  const lib = await import("pdfjs-dist");
  if (!workerReady) {
    // The worker is bundled from the package itself (Turbopack: new Worker(new URL(...))).
    lib.GlobalWorkerOptions.workerPort = new Worker(
      new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url),
      { type: "module" },
    );
    workerReady = true;
  }
  return lib;
}

/** The same-origin folder of pdf.js's run-time files for the installed version. */
export const pdfjsAssetsBase = (version: string) => `/pdfjs/${version}/`;

/**
 * Fetches a PDF through its owner-checked route and opens it; `destroy` ends the loading task,
 * which frees the document in pdf.js's worker (also when it is still loading).
 */
function openPdf(url: string): { pdf: Promise<PDFDocumentProxy>; destroy: () => void } {
  let task: PDFDocumentLoadingTask | null = null;
  const state = { destroyed: false };
  const pdf = (async () => {
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`pdf: ${String(response.status)}`);
    const data = new Uint8Array(await response.arrayBuffer());
    const lib = await pdfjs();
    if (state.destroyed) throw new Error("pdf: released");
    const base = pdfjsAssetsBase(lib.version);
    task = lib.getDocument({
      data,
      enableXfa: false,
      wasmUrl: `${base}wasm/`,
      iccUrl: `${base}iccs/`,
      standardFontDataUrl: `${base}standard_fonts/`,
    });
    return task.promise;
  })();
  return {
    pdf,
    destroy: () => {
      state.destroyed = true;
      void task?.destroy();
    },
  };
}

interface Cached {
  pdf: Promise<PDFDocumentProxy>;
  destroy: () => void;
  users: number;
  timer: ReturnType<typeof setTimeout> | null;
}
const documents = new Map<string, Cached>();

function destroy(url: string, entry: Cached) {
  documents.delete(url);
  entry.destroy();
}

/**
 * The document behind `url`, shared by everything that uses it. Call `release` when done: the
 * last release destroys it after RELEASE_GRACE_MS unless it is acquired again meanwhile.
 */
export function acquirePdf(url: string): {
  pdf: Promise<PDFDocumentProxy>;
  release: () => void;
} {
  let entry = documents.get(url);
  if (!entry) {
    entry = { ...openPdf(url), users: 0, timer: null };
    // A failed load is not kept: the next use tries again.
    const failed = entry;
    entry.pdf.catch(() => {
      if (documents.get(url) === failed) documents.delete(url);
    });
    documents.set(url, entry);
  }
  const held = entry;
  if (held.timer) clearTimeout(held.timer);
  held.timer = null;
  held.users += 1;
  let released = false;
  return {
    pdf: held.pdf,
    release: () => {
      if (released) return;
      released = true;
      held.users -= 1;
      if (held.users > 0 || documents.get(url) !== held) return;
      held.timer = setTimeout(() => {
        if (held.users === 0) destroy(url, held);
      }, RELEASE_GRACE_MS);
    },
  };
}

/**
 * Draws one page into `canvas` so that its longest side is `side` pixels. An aborted `signal`
 * cancels the drawing (a canvas takes one drawing at a time).
 */
export async function drawPdfPage(
  pdf: PDFDocumentProxy,
  pageNo: number,
  canvas: HTMLCanvasElement,
  side: number,
  signal?: AbortSignal,
): Promise<void> {
  const page = await pdf.getPage(pageNo);
  if (signal?.aborted) return;
  const base = page.getViewport({ scale: 1 });
  const scale = side / Math.max(base.width, base.height);
  const viewport = page.getViewport({ scale });
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const task = page.render({ canvas, viewport });
  const cancel = () => {
    task.cancel();
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    await task.promise;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("png: canvas is empty"));
    }, "image/png");
  });
}

/** Whether a drawn canvas shows (almost) nothing: the same rule the job applies. */
function looksBlank(canvas: HTMLCanvasElement): boolean {
  const context = canvas.getContext("2d");
  if (!context) return false;
  return isBlankShare(
    inkShare(context.getImageData(0, 0, canvas.width, canvas.height).data),
  );
}

export interface PagePicture {
  png: Blob;
  /** Nothing readable on it: OCR would only spend the day's cap. */
  blank: boolean;
}

/**
 * A PNG of at most MAX_PAGE_IMAGE_BYTES and MAX_PAGE_IMAGE_SIDE: drawn at OCR_RENDER_SIDE first,
 * then smaller until it fits.
 */
async function fittingPng(
  draw: (side: number) => Promise<HTMLCanvasElement>,
): Promise<PagePicture> {
  let side = Math.min(OCR_RENDER_SIDE, MAX_PAGE_IMAGE_SIDE);
  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const canvas = await draw(side);
    const png = await toPng(canvas);
    if (png.size <= MAX_PAGE_IMAGE_BYTES) return { png, blank: looksBlank(canvas) };
    side = Math.floor(side * SHRINK);
  }
  throw new Error("png: page too large");
}

/** The PNG of one PDF page for OCR, drawn on a white page. */
export function renderPdfPagePng(
  pdf: PDFDocumentProxy,
  pageNo: number,
): Promise<PagePicture> {
  return fittingPng(async (side) => {
    const canvas = document.createElement("canvas");
    await drawPdfPage(pdf, pageNo, canvas, side);
    return canvas;
  });
}

/** A smaller PNG of a photo whose file is too large to send to OCR as it is. */
export async function renderImagePng(url: string): Promise<PagePicture> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`image: ${String(response.status)}`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    return await fittingPng((side) => {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(bitmap.width * scale));
      canvas.height = Math.max(1, Math.floor(bitmap.height * scale));
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return Promise.resolve(canvas);
    });
  } finally {
    bitmap.close();
  }
}
