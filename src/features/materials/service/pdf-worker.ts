import "server-only";
import { runBoundedWorker } from "./bounded-worker";

// Ruling R10: every parse of an untrusted PDF (the finalise check here, Task 4's ingestion later)
// runs in pdf.worker.mjs on a worker thread with its own heap limits and a hard timeout. A worker
// that crashes, runs out of heap or out of time means "damaged": the caller rejects the file.

export const PDF_WORKER_LIMITS = {
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
} as const;
export const PDF_WORKER_TIMEOUT_MS = 20_000;

export type PdfInspection =
  | { status: "ok"; pages: number }
  | { status: "encrypted" }
  | { status: "damaged" }
  /** Another parse held the process's slot for longer than `waitMs` (R29): nothing was read. */
  | { status: "busy" };

/**
 * Opens the PDF in a bounded worker and reports its page count, or that it is encrypted (a user
 * password, or an owner password only) or damaged. The bytes are copied into the worker; the
 * caller keeps its own. Never throws.
 */
export async function inspectPdf(
  bytes: Uint8Array,
  options: { ownerId: string; timeoutMs?: number; waitMs?: number },
): Promise<PdfInspection> {
  const result = await runBoundedWorker<PdfInspection>(
    // The literal `new URL(..., import.meta.url)` form lets the bundler emit the worker file.
    new URL("./pdf.worker.mjs", import.meta.url),
    {
      ownerId: options.ownerId,
      // Copied only once the parse slot is held (R29).
      payload: () => {
        const copy = bytes.slice().buffer;
        return { data: { op: "inspect", bytes: copy }, transfer: [copy] };
      },
      timeoutMs: options.timeoutMs ?? PDF_WORKER_TIMEOUT_MS,
      waitMs: options.waitMs,
      resourceLimits: PDF_WORKER_LIMITS,
    },
  );
  if (!result.ok) return { status: result.reason === "busy" ? "busy" : "damaged" };
  const answer = result.value;
  if (
    answer.status === "ok" &&
    !(Number.isSafeInteger(answer.pages) && answer.pages >= 0)
  ) {
    return { status: "damaged" };
  }
  return answer;
}
