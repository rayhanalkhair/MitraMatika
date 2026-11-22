import "server-only";
import { MAX_PDF_PAGES } from "../schema/upload";
import { runBoundedWorker } from "./bounded-worker";
import { cleanPageText, MAX_PAGE_CHARS } from "./page-quality";
import { PDF_WORKER_LIMITS, PDF_WORKER_TIMEOUT_MS } from "./pdf-worker";

// The text layer of a range of PDF pages for ingestion. Rulings R10/R12: the PDF is parsed in
// pdf.worker.mjs (op "text") on a worker thread with the same heap limits and hard timeout as the
// finalise check; a crash, a timeout or a malformed answer is "damaged".

export type PdfTextResult =
  | { status: "ok"; pages: number; texts: string[] }
  | { status: "encrypted" }
  | { status: "damaged" }
  /** Another parse held the process's slot for longer than `waitMs` (R29): nothing was read. */
  | { status: "busy" };

const isPageCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * The cleaned text of pages `from`..`to` (1-based, inclusive), never past the last page nor past
 * MAX_PDF_PAGES, and the document's page count as pdf.js reads it. A page without a text layer
 * gives "". Throws a RangeError for a range that does not start at a page.
 */
export async function extractPdfText(
  bytes: Uint8Array,
  range: {
    from: number;
    to: number;
    ownerId: string;
    timeoutMs?: number;
    waitMs?: number;
  },
): Promise<PdfTextResult> {
  const { from, to } = range;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) {
    throw new RangeError("extractPdfText: invalid page range");
  }
  const last = Math.min(to, MAX_PDF_PAGES);
  const result = await runBoundedWorker<unknown>(
    new URL("./pdf.worker.mjs", import.meta.url),
    {
      ownerId: range.ownerId,
      // Copied only once the parse slot is held (R29).
      payload: () => {
        const copy = bytes.slice().buffer;
        return {
          data: { op: "text", bytes: copy, from, to: last, maxChars: MAX_PAGE_CHARS },
          transfer: [copy],
        };
      },
      timeoutMs: range.timeoutMs ?? PDF_WORKER_TIMEOUT_MS,
      waitMs: range.waitMs,
      resourceLimits: PDF_WORKER_LIMITS,
    },
  );
  if (!result.ok) return { status: result.reason === "busy" ? "busy" : "damaged" };
  const answer = result.value as { status?: unknown; pages?: unknown; texts?: unknown };
  if (answer.status === "encrypted") return { status: "encrypted" };
  if (
    answer.status !== "ok" ||
    !isPageCount(answer.pages) ||
    !Array.isArray(answer.texts)
  ) {
    return { status: "damaged" };
  }
  const expected = Math.max(0, Math.min(last, answer.pages) - from + 1);
  const texts: unknown[] = answer.texts;
  const isText = (text: unknown): text is string => typeof text === "string";
  if (texts.length !== expected || !texts.every(isText)) {
    return { status: "damaged" };
  }
  return {
    status: "ok",
    pages: answer.pages,
    texts: texts.map(cleanPageText),
  };
}
