// The OCR service (decisions 5 and 7), in three parts: the queue and its page images
// (ocr-queue.ts), the review reads and corrections (ocr-review.ts) and the `ocr_pages` job
// (ocr-job.ts).
export { USER_DAILY_OCR_PAGES } from "../schema/ocr";
export {
  checkPageImage,
  needsPageUpload,
  pageImageKey,
  pageStagingKey,
  prepareOcrUploads,
  queueOcr,
} from "./ocr-queue";
export { getReviewPage, listReviewPages, savePageText } from "./ocr-review";
export type { ReviewPage, ReviewPageSummary } from "./ocr-review";
export {
  createOcrPagesHandler,
  MIN_PAGE_MS,
  OCR_MAX_OUTPUT_TOKENS,
  OCR_QUOTA,
  ocrPageText,
  readVisionSpends,
  teacherVisionPlan,
  VISION_TEACHER_SHARE,
  RESERVED as VISION_RESERVED,
  sweepStuckOcrPages,
  visionBudget,
} from "./ocr-job";
export type { OcrFlag, OcrPagesDeps, OcrPageText, VisionSpend } from "./ocr-job";
