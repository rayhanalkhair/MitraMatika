"use server";

import { authorizeAction } from "@/features/auth";
import { getDb } from "@/lib/db/runtime";
import { logger } from "@/lib/logger";
import { getObjectStore } from "@/lib/storage";
import { startUploadSchema, type StartUploadState } from "../schema/upload";
import { startUpload } from "../service/upload";

/**
 * Step 1 of an upload: the browser sends the file's name, type and size (never the file); the
 * answer is a PUT URL signed for exactly that size, valid for 5 minutes. The file then goes
 * straight to the store, never through a Next.js function.
 */
export async function startUploadAction(input: {
  fileName: string;
  declaredType: string;
  size: number;
}): Promise<StartUploadState> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { ok: false, error: "unauthenticated" };
  const parsed = startUploadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "generic" };
  try {
    const result = await startUpload(getDb(), getObjectStore(), {
      ...parsed.data,
      ownerId: authorization.data.userId,
      now: new Date(),
    });
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, ...result.data };
  } catch (error) {
    logger.error(
      { module: "materials", err: error instanceof Error ? error.name : typeof error },
      "materials: could not start an upload",
    );
    return { ok: false, error: "generic" };
  }
}
