"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizeAction } from "@/features/auth";
import { getDb } from "@/lib/db/runtime";
import { audit } from "@/lib/events";
import { logger } from "@/lib/logger";
import { restoreQuestion } from "../service/trash";
import {
  AUDIT_QUESTION_UNTRASHED,
  safeErrorSummary,
  TRASH_REASONS,
  type TrashActionResult,
} from "./action-support";

const requestSchema = z.object({ questionId: z.uuid() });

/** Takes one of the signed-in teacher's questions out of the trash, unchanged. */
export async function restoreQuestionAction(raw: unknown): Promise<TrashActionResult> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { ok: false, reason: "signed_out" };
  const request = requestSchema.safeParse(raw);
  if (!request.success) return { ok: false, reason: "generic" };
  const ownerId = authorization.data.userId;
  const { questionId } = request.data;
  try {
    const result = await restoreQuestion(getDb(), { ownerId, questionId });
    if (!result.ok) return { ok: false, reason: TRASH_REASONS[result.error] };
    await audit({
      ownerId,
      action: AUDIT_QUESTION_UNTRASHED,
      entityType: "question",
      entityId: questionId,
    });
    revalidatePath("/trash");
    revalidatePath("/question-bank");
    revalidatePath("/home");
    return { ok: true };
  } catch (error) {
    logger.error(
      { module: "trash", err: safeErrorSummary(error) },
      "trash: could not restore the question",
    );
    return { ok: false, reason: "generic" };
  }
}
