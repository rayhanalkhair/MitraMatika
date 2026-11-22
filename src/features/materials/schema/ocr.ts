// OCR on demand (decision 5 of the materials plan) and the review of a page's text (decision 7):
// the limits, the job name and the shapes of what the teacher sends and what the model returns.
// Nothing the model returns is executed: its Markdown is stored as text.
import { z } from "zod";
import { MAX_PAGE_CHARS } from "../service/page-quality";

export const OCR_PAGES_JOB = "ocr_pages";
/** Pages one teacher may send to OCR per Asia/Jakarta day ("x of 20 pages left today"). */
export const USER_DAILY_OCR_PAGES = 20;
/**
 * Ruling R28: every call of the vision model one teacher may start per Asia/Jakarta day, OCR
 * pages (1 each, within the 20 above) and solver photo reads (1 each) together.
 */
export const USER_DAILY_VISION_READS = 25;
/**
 * The largest page image sent to the vision model, in raw bytes. Its base64 (4/3 of it) stays
 * under the gateway's 3.5 MiB image limit (src/lib/ai/images.ts) with room to spare.
 */
export const MAX_PAGE_IMAGE_BYTES = 2_500_000;
/**
 * The longest side of a page image in pixels (the browser renders 2,000). It also bounds the
 * pixels the job decodes for the blank-page check (at most 3,000 x 3,000 x 4 bytes).
 */
export const MAX_PAGE_IMAGE_SIDE = 3_000;
/** How long a signed PUT URL for a page image is valid (seconds). */
export const PAGE_UPLOAD_URL_SECONDS = 300;
/** The longest text a teacher may save for one page (the same cap as extracted text). */
export const MAX_MANUAL_PAGE_CHARS = MAX_PAGE_CHARS;
/** Pages one request may queue (never more than a whole day's cap). */
export const MAX_PAGES_PER_REQUEST = USER_DAILY_OCR_PAGES;

const pageNo = z.number().int().min(1).max(100_000);
const pageNos = z
  .array(pageNo)
  .min(1)
  .max(MAX_PAGES_PER_REQUEST)
  .transform((list) => [...new Set(list)].sort((a, b) => a - b));

/** The teacher's selection: which pages of which material. */
export const ocrSelectionSchema = z.object({
  materialId: z.uuid(),
  pageNos,
});
export type OcrSelection = z.infer<typeof ocrSelectionSchema>;

/** The page images the browser rendered: the exact byte size of each PNG. */
export const pageUploadRequestSchema = z.object({
  materialId: z.uuid(),
  pages: z
    .array(
      z.object({
        pageNo,
        size: z.number().int().min(1).max(MAX_PAGE_IMAGE_BYTES),
      }),
    )
    .min(1)
    .max(MAX_PAGES_PER_REQUEST),
});
export type PageUploadRequest = z.infer<typeof pageUploadRequestSchema>;

/** A teacher's correction of one page. */
export const savePageTextSchema = z.object({
  materialId: z.uuid(),
  pageNo,
  textMd: z.string(),
});
export type SavePageTextInput = z.infer<typeof savePageTextSchema>;

/** The vision model's answer (unknown keys dropped; the text is cut to the page cap later). */
export const ocrAnswerSchema = z.object({
  markdown: z.string().max(200_000),
});
export type OcrAnswer = z.infer<typeof ocrAnswerSchema>;

export type QueueOcrError = "notFound" | "pages" | "limit";
/** `appFull`: the app-wide storage cap is reached (ADR-0022), so no page image is signed. */
export type PageUploadError = "notFound" | "pages" | "limit" | "appFull";
export type SavePageTextError = "notFound" | "notReady" | "tooLong" | "busy";

/** Why one page's OCR ended without text (job progress, never page content). */
export type OcrPageFailure =
  | "image_missing"
  | "image_invalid"
  | "image_too_large"
  | "image_blank"
  | "invalid_output"
  | "truncated"
  | "material_gone";
