"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizeAction } from "@/features/auth";
import { getDb } from "@/lib/db/runtime";
import { audit } from "@/lib/events";
import { logger } from "@/lib/logger";
import { deletePermanently } from "../service/trash";
import {
  AUDIT_QUESTION_DELETED,
  refusal,
  safeErrorSummary,
  type TrashActionResult,
} from "./action-support";

const requestSchema = z.object({ questionId: z.uuid() });

/** Deletes one of the signed-in teacher's trashed questions for good. */
export async function deletePermanentlyAction(raw: unknown): Promise<TrashActionResult> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { ok: false, reason: "signed_out" };
  const request = requestSchema.safeParse(raw);
  if (!request.success) return { ok: false, reason: "generic" };
  const ownerId = authorization.data.userId;
  const { questionId } = request.data;
  try {
    const result = await deletePermanently(getDb(), {
      ownerId,
      questionId,
      now: new Date(),
    });
    // A question an assessment pins is refused with the assessments' titles (R2).
    if (!result.ok) return refusal(result.error);
    // Ids and counts only.
    await audit({
      ownerId,
      action: AUDIT_QUESTION_DELETED,
      entityType: "question",
      entityId: questionId,
      metadata: result.data,
    });
    revalidatePath("/trash");
    return { ok: true };
  } catch (error) {
    logger.error(
      { module: "trash", err: safeErrorSummary(error) },
      "trash: could not delete the question",
    );
    return { ok: false, reason: "generic" };
  }
}
