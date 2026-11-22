// The problem solver (decisions 10 and 11 of the materials plan): limits, job names and the shapes
// of what the teacher sends. Safe for the browser (the model answers live in answers.ts).
import { z } from "zod";

/**
 * Solver runs one teacher may start per Asia/Jakarta day (decision 11). One run is one model job:
 * reading a photo, solving, solving again after a failure, or "show another method". The first
 * solve after a photo was read is part of that photo's run and does not count again.
 */
export const USER_DAILY_SOLVES = 30;
/** The longest problem text (typed, or confirmed after a photo was read). */
export const MAX_PROBLEM_CHARS = 4_000;
/**
 * The largest photo sent to the vision model, in raw bytes (its base64 stays under the gateway's
 * 3.5 MiB image limit). The browser shrinks a larger photo before uploading it.
 */
export const MAX_SOLVER_PHOTO_BYTES = 2_500_000;
/** The longest side of a photo in pixels, and its largest area. */
export const MAX_SOLVER_PHOTO_SIDE = 6_000;
export const MAX_SOLVER_PHOTO_PIXELS = 24_000_000;
/** How long the signed PUT URL of a photo is valid (seconds). */
export const PHOTO_UPLOAD_URL_SECONDS = 300;
/** A photo that was never confirmed after this long cannot be finalised any more. */
export const PHOTO_FINALIZE_WINDOW_MS = 60 * 60_000;
/** Photo uploads one teacher may have started and not finalised within the window. */
export const MAX_PENDING_PHOTOS = 10;
/** Solver photos are deleted from storage this long after their session started (decision 10). */
export const PHOTO_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** The "recent" list (decision 10). */
export const RECENT_SESSIONS = 20;
/** Methods per session: the first one and at most three others (SOL-04). */
export const MAX_METHODS = 4;
export const MAX_METHOD_LABEL_CHARS = 80;
export const MAX_STEPS = 20;

export const EXTRACT_PROBLEM_JOB = "extract_problem";
/** A photo reading is claimed before bulk work such as OCR pages (jobs.priority, higher first). */
export const PHOTO_READ_PRIORITY = 10;
export const SOLVE_PROBLEM_JOB = "solve_problem";
export const ALTERNATIVE_METHOD_JOB = "alternative_method";
export const SOLVER_JOB_TYPES = [
  EXTRACT_PROBLEM_JOB,
  SOLVE_PROBLEM_JOB,
  ALTERNATIVE_METHOD_JOB,
] as const;

export const SOLVER_PHOTO_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
} as const;
export type SolverPhotoMime = keyof typeof SOLVER_PHOTO_TYPES;
export const SOLVER_PHOTO_ACCEPT = "image/jpeg,image/png";

export const SESSION_STATUSES = [
  "pending",
  "extracting",
  "needs_confirmation",
  "ready",
  "solved",
  "failed",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Why an extraction must be confirmed before solving (SOL-02). */
export const EXTRACTION_FLAGS = ["uncertain", "katex", "truncated", "empty"] as const;
export type ExtractionFlag = (typeof EXTRACTION_FLAGS)[number];

const problemText = z.string().max(MAX_PROBLEM_CHARS * 2);

export const textProblemSchema = z.object({ text: problemText });
export const startPhotoSchema = z.object({
  kind: z.enum(["photo", "file"]),
  mime: z.enum(["image/png", "image/jpeg"]),
  size: z.number().int().min(1).max(MAX_SOLVER_PHOTO_BYTES),
});
export const sessionIdSchema = z.object({ sessionId: z.uuid() });
export const confirmExtractionSchema = z.object({
  sessionId: z.uuid(),
  text: problemText,
});

export interface SolutionStep {
  title: string | null;
  bodyMd: string;
}
export interface FinalAnswer {
  value: string;
  unit: string | null;
  rounding: string | null;
}

export type TextSessionError = "empty" | "tooLong" | "limit";
/** `visionLimit`: the day's 25 vision reads (OCR pages and photos together, R28) are used. */
export type StartPhotoError = "limit" | "visionLimit" | "pending";
export type FinalizePhotoError =
  | "notFound"
  | "missing"
  | "type"
  | "size"
  | "image"
  | "expired"
  | "limit"
  | "visionLimit";
export type ConfirmExtractionError =
  "notFound" | "state" | "empty" | "tooLong" | "markers" | "limit";
export type SolveAgainError = "notFound" | "state" | "busy" | "limit";
export type AlternativeError = "notFound" | "state" | "busy" | "limit" | "noMore";
