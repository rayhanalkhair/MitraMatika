// The text of a Word document as pages (decision 4: text_source "docx"). The extraction itself
// (jszip, the OMML rewrite, mammoth, the page model) runs in docx.worker.mjs on a worker thread
// with a heap limit and a hard timeout (Ruling R15), like PDF parsing (R10): a crafted document can
// neither exhaust the job's memory nor block its event loop. See the worker for the page model.
// Finalise's zip limits are re-applied here first; they stream and stay bounded.
import "server-only";
import { err, ok, type Result } from "@/lib/result";
import { MAX_PDF_PAGES } from "../schema/upload";
import { runBoundedWorker } from "./bounded-worker";
import { cleanPageText } from "./page-quality";
import { validateMaterialFile } from "./validate";

export const DOCX_PAGE_CHARS = 3000;
/**
 * The largest word/document.xml read (inflated). mammoth builds a DOM of the whole part (about
 * 140 MB of heap per MB of XML, review of Task 4), so this keeps it inside the worker's heap.
 */
export const MAX_DOCX_XML_BYTES = 4 * 1024 * 1024;
/** Deeper element nesting is refused before mammoth sees it (its cost grows much faster). */
export const MAX_DOCX_XML_DEPTH = 256;
export const DOCX_WORKER_LIMITS = {
  maxOldGenerationSizeMb: 768,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
} as const;
export const DOCX_WORKER_TIMEOUT_MS = 30_000;

/** `busy`: another parse held the process's slot for longer than `waitMs` (R29). */
export type DocxTextError = "damaged" | "zipBomb" | "tooLarge" | "busy";
export interface DocxPages {
  pages: string[];
  /** The document had more than MAX_PDF_PAGES pages; the rest was not kept. */
  truncated: boolean;
}

export interface DocxOptions {
  /** The teacher the parse is for (R29: one parse per owner at a time). */
  ownerId: string;
  maxXmlBytes?: number;
  timeoutMs?: number;
  /** How long to wait for the process's parse slot (R29). */
  waitMs?: number;
  resourceLimits?: { maxOldGenerationSizeMb: number; maxYoungGenerationSizeMb: number };
}

const isText = (value: unknown): value is string => typeof value === "string";

/**
 * The pages of a DOCX, at most MAX_PDF_PAGES. Never throws for a bad file: `damaged` (also when
 * the worker crashes, runs out of heap or out of time), `zipBomb` or `tooLarge`.
 */
export async function extractDocxPages(
  bytes: Uint8Array,
  options: DocxOptions,
): Promise<Result<DocxPages, DocxTextError>> {
  const checked = await validateMaterialFile(bytes, "docx", { ownerId: options.ownerId });
  if (!checked.ok) return err(checked.error === "zipBomb" ? "zipBomb" : "damaged");

  const result = await runBoundedWorker<unknown>(
    // The literal `new URL(..., import.meta.url)` form lets the bundler emit the worker file.
    new URL("./docx.worker.mjs", import.meta.url),
    {
      ownerId: options.ownerId,
      // Copied only once the parse slot is held (R29).
      payload: () => {
        const copy = bytes.slice().buffer;
        return {
          data: {
            op: "docx",
            bytes: copy,
            limits: {
              maxXmlBytes: options.maxXmlBytes ?? MAX_DOCX_XML_BYTES,
              maxDepth: MAX_DOCX_XML_DEPTH,
              pageChars: DOCX_PAGE_CHARS,
              maxPages: MAX_PDF_PAGES,
            },
          },
          transfer: [copy],
        };
      },
      timeoutMs: options.timeoutMs ?? DOCX_WORKER_TIMEOUT_MS,
      waitMs: options.waitMs,
      resourceLimits: { ...DOCX_WORKER_LIMITS, ...options.resourceLimits },
    },
  );
  if (!result.ok) return err(result.reason === "busy" ? "busy" : "damaged");
  const answer = result.value as {
    status?: unknown;
    pages?: unknown;
    truncated?: unknown;
  };
  if (answer.status === "tooLarge") return err("tooLarge");
  if (
    answer.status !== "ok" ||
    !Array.isArray(answer.pages) ||
    typeof answer.truncated !== "boolean"
  ) {
    return err("damaged");
  }
  const pages: unknown[] = answer.pages;
  if (pages.length > MAX_PDF_PAGES || !pages.every(isText)) return err("damaged");
  const cleaned = pages.map(cleanPageText);
  return ok({ pages: cleaned.length > 0 ? cleaned : [""], truncated: answer.truncated });
}
