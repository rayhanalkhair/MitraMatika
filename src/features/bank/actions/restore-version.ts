"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizeAction } from "@/features/auth";
import { AUDIT_QUESTION_RESTORED } from "@/features/generation";
import { getDb } from "@/lib/db/runtime";
import { audit } from "@/lib/events";
import { logger } from "@/lib/logger";
import { restoreVersion } from "../service/versions";

// The wire shape the client reads: flat fields on success, a `reason` on failure.
export type RestoreVersionResult =
  | { ok: true; versionId: string }
  | {
      ok: false;
      reason:
        | "signed_out"
        | "not_found"
        | "stale"
        | "trashed"
        | "not_ready"
        | "current"
        | "generic";
    };

const requestSchema = z.object({
  questionId: z.uuid(),
  versionId: z.uuid(),
  expectedRowVersion: z.number().int().min(1),
});

const REASONS = {
  notFound: "not_found",
  stale: "stale",
  trashed: "trashed",
  notReady: "not_ready",
  current: "current",
} as const;

// A database error message carries the SQL parameters, which include the question text. Log only
// the error name and the Postgres code.
function safeErrorSummary(error: unknown): { name: string; code: string | null } {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return {
    name: error instanceof Error ? error.name : typeof error,
    code: typeof code === "string" ? code : null,
  };
}

export async function restoreVersionAction(raw: unknown): Promise<RestoreVersionResult> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { ok: false, reason: "signed_out" };

  const request = requestSchema.safeParse(raw);
  if (!request.success) return { ok: false, reason: "generic" };
  // The owner is the signed-in teacher, never anything the client sent. The service connection
  // writes (the `authenticated` role may not insert versions); every statement names owner_id.
  const ownerId = authorization.data.userId;
  const { questionId, versionId, expectedRowVersion } = request.data;

  try {
    const result = await restoreVersion(getDb(), {
      ownerId,
      questionId,
      versionId,
      expectedRowVersion,
      now: new Date(),
    });
    if (!result.ok) return { ok: false, reason: REASONS[result.error] };

    await audit({
      ownerId,
      action: AUDIT_QUESTION_RESTORED,
      entityType: "question",
      entityId: questionId,
      metadata: { fromVersionId: versionId, versionId: result.data.versionId },
    });
    revalidatePath(`/question-bank/${questionId}`);
    revalidatePath("/question-bank");
    return { ok: true, versionId: result.data.versionId };
  } catch (error) {
    logger.error(
      { module: "bank", err: safeErrorSummary(error) },
      "bank: could not restore the version",
    );
    return { ok: false, reason: "generic" };
  }
}
