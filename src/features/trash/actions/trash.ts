"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizeAction } from "@/features/auth";
import { getDb } from "@/lib/db/runtime";
import { audit } from "@/lib/events";
import { logger } from "@/lib/logger";
import { trashQuestion } from "../service/trash";
import {
  AUDIT_QUESTION_TRASHED,
  safeErrorSummary,
  TRASH_REASONS,
  type TrashActionResult,
} from "./action-support";

const requestSchema = z.object({ questionId: z.uuid() });

/** Moves one of the signed-in teacher's questions to the trash for 30 days. */
export async function trashQuestionAction(raw: unknown): Promise<TrashActionResult> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { ok: false, reason: "signed_out" };
  const request = requestSchema.safeParse(raw);
  if (!request.success) return { ok: false, reason: "generic" };
  // The owner is the signed-in teacher, never anything the client sent (R9).
  const ownerId = authorization.data.userId;
  const { questionId } = request.data;
  try {
    const result = await trashQuestion(getDb(), { ownerId, questionId, now: new Date() });
    if (!result.ok) return { ok: false, reason: TRASH_REASONS[result.error] };
    await audit({
      ownerId,
      action: AUDIT_QUESTION_TRASHED,
      entityType: "question",
      entityId: questionId,
    });
    revalidatePath("/question-bank");
    revalidatePath(`/question-bank/${questionId}`);
    revalidatePath("/trash");
    revalidatePath("/home");
    return { ok: true };
  } catch (error) {
    logger.error(
      { module: "trash", err: safeErrorSummary(error) },
      "trash: could not move the question to the trash",
    );
    return { ok: false, reason: "generic" };
  }
}
