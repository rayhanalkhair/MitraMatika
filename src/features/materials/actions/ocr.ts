"use server";

import { revalidatePath } from "next/cache";
import { authorizeAction } from "@/features/auth";
import { getDb } from "@/lib/db/runtime";
import { scheduleRun } from "@/lib/jobs/trigger";
import { logger } from "@/lib/logger";
import { getObjectStore } from "@/lib/storage";
import {
  ocrSelectionSchema,
  pageUploadRequestSchema,
  savePageTextSchema,
  type PageUploadError,
  type QueueOcrError,
  type SavePageTextError,
} from "../schema/ocr";
import { prepareOcrUploads, queueOcr, savePageText } from "../service/ocr";
import { ocrPagesLeft } from "../service/ocr-quota";
import type { MaterialDb } from "../service/upload";

// OCR on demand and the teacher's corrections. Pages, OCR usage and jobs are server-written, so
// these run on the service connection with the owner taken from the session, never from the
// client (bank R9). The page that hosts them (/materials/[id]) exports maxDuration = 300 for the
// run that queueOcrAction schedules.

type Failure = "invalid" | "unauthenticated" | "generic";
export type PrepareOcrUploadsState =
  | { ok: true; uploads: { pageNo: number; url: string }[]; left: number }
  | { ok: false; error: PageUploadError | Failure };
export type QueueOcrState =
  | { ok: true; left: number; jobId: string }
  | { ok: false; error: QueueOcrError | Failure };
export type SavePageTextState =
  { ok: true } | { ok: false; error: SavePageTextError | Failure };

function crashed(error: unknown, message: string) {
  logger.error(
    { module: "materials", err: error instanceof Error ? error.name : typeof error },
    message,
  );
  return { ok: false as const, error: "generic" as const };
}

/** Signed PUT URLs for the page images the browser rendered (PDF pages, large photos). */
export async function prepareOcrUploadsAction(
  input: unknown,
): Promise<PrepareOcrUploadsState> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { ok: false, error: "unauthenticated" };
  const parsed = pageUploadRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const ownerId = authorization.data.userId;
  try {
    const db = getDb() as unknown as MaterialDb;
    const left = await ocrPagesLeft(db, { ownerId, now: new Date() });
    const result = await prepareOcrUploads(db, getObjectStore(), {
      ownerId,
      materialId: parsed.data.materialId,
      pages: parsed.data.pages,
      left,
    });
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, uploads: result.data.uploads, left };
  } catch (error) {
    return crashed(error, "materials: could not prepare OCR page uploads");
  }
}

/** Sends the selected pages to OCR (counted in today's cap) and starts the runner. */
export async function queueOcrAction(input: unknown): Promise<QueueOcrState> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { ok: false, error: "unauthenticated" };
  const parsed = ocrSelectionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const ownerId = authorization.data.userId;
  const { materialId, pageNos } = parsed.data;
  try {
    const result = await getDb().transaction((tx) =>
      queueOcr(tx as unknown as MaterialDb, {
        ownerId,
        materialId,
        pageNos,
        now: new Date(),
      }),
    );
    if (!result.ok) return { ok: false, error: result.error };
    try {
      scheduleRun();
    } catch {
      // The status poll (or the daily run) runs the job.
    }
    revalidatePath(`/materials/${materialId}`);
    return { ok: true, left: result.data.left, jobId: result.data.jobId };
  } catch (error) {
    return crashed(error, "materials: could not queue OCR");
  }
}

/** Saves the teacher's text for one page (text_source manual, flags cleared). */
export async function savePageTextAction(input: unknown): Promise<SavePageTextState> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { ok: false, error: "unauthenticated" };
  const parsed = savePageTextSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const { materialId, pageNo, textMd } = parsed.data;
  try {
    const result = await getDb().transaction((tx) =>
      savePageText(tx as unknown as MaterialDb, {
        ownerId: authorization.data.userId,
        materialId,
        pageNo,
        textMd,
        now: new Date(),
      }),
    );
    if (!result.ok) return { ok: false, error: result.error };
    revalidatePath(`/materials/${materialId}`);
    return { ok: true };
  } catch (error) {
    return crashed(error, "materials: could not save a page's text");
  }
}
