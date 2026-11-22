"use server";

import { authorizeAction } from "@/features/auth";
import { getDb } from "@/lib/db/runtime";
import { logger } from "@/lib/logger";
import { getObjectStore } from "@/lib/storage";
import { cancelUploadSchema, type CancelUploadState } from "../schema/upload";
import { cancelUpload } from "../service/upload";

/**
 * The teacher cancels an upload in progress: its staging file goes at once, and the reservation is
 * marked cancelled. It keeps counting toward the pending and storage caps until its signed URL has
 * expired, so a cancel cannot be used to get around them.
 */
export async function cancelUploadAction(input: {
  objectKey: string;
}): Promise<CancelUploadState> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { ok: false, error: "unauthenticated" };
  const parsed = cancelUploadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "generic" };
  try {
    const result = await cancelUpload(getDb(), getObjectStore(), {
      ownerId: authorization.data.userId,
      objectKey: parsed.data.objectKey,
      now: new Date(),
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    logger.error(
      { module: "materials", err: error instanceof Error ? error.name : typeof error },
      "materials: could not cancel an upload",
    );
    return { ok: false, error: "generic" };
  }
}
