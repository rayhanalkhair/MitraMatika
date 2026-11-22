"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizeAction } from "@/features/auth";
import { AUDIT_QUESTION_EDITED } from "@/features/generation";
import { getDb } from "@/lib/db/runtime";
import { audit } from "@/lib/events";
import { logger } from "@/lib/logger";
import { editFormSchema } from "../schema/edit-input";
import { editQuestion } from "../service/edit-question";

// The wire shape the editor reads: flat fields on success, a `reason` on failure.
export type EditQuestionResult =
  | { ok: true; versionId: string; status: string }
  | {
      ok: false;
      reason:
        | "signed_out"
        | "not_found"
        | "stale"
        | "trashed"
        | "not_ready"
        | "regenerating"
        | "generic";
    }
  | { ok: false; reason: "invalid" | "invalid_math"; fields: string[] };

const requestSchema = z.object({
  questionId: z.uuid(),
  expectedRowVersion: z.number().int().min(1),
  content: z.unknown(),
});

/** Field paths of what is wrong, e.g. "stemMd" or "options.2.textMd"; empty when not an object. */
function invalidFields(error: z.ZodError): string[] {
  const fields = new Set<string>();
  for (const issue of error.issues) {
    if (issue.path.length > 0) fields.add(issue.path.join("."));
  }
  return [...fields];
}

/**
 * The service names a step by its place among the saved (non-blank) steps, `steps.1`; the form
 * names it by its row, `steps.2.textMd`. Other paths already are form names.
 */
function toFormPath(path: string, rows: unknown): string {
  const match = /^steps\.(\d+)$/.exec(path);
  if (!match) return path;
  const filled: number[] = [];
  if (Array.isArray(rows)) {
    rows.forEach((row: unknown, index) => {
      const text = (row as { textMd?: unknown } | null)?.textMd;
      if (typeof text === "string" && text.trim() !== "") filled.push(index);
    });
  }
  const row = filled.at(Number(match[1]));
  return row === undefined ? "steps" : `steps.${String(row)}.textMd`;
}

// A database error message carries the SQL parameters, which include the question text. Log only
// the error name and the Postgres code.
function safeErrorSummary(error: unknown): { name: string; code: string | null } {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return {
    name: error instanceof Error ? error.name : typeof error,
    code: typeof code === "string" ? code : null,
  };
}

export async function editQuestionAction(raw: unknown): Promise<EditQuestionResult> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { ok: false, reason: "signed_out" };

  const request = requestSchema.safeParse(raw);
  if (!request.success) return { ok: false, reason: "generic" };
  const content = editFormSchema.safeParse(request.data.content);
  // No field to mark (not even an object): nothing the teacher can fix on the form.
  if (!content.success) {
    const fields = invalidFields(content.error);
    return fields.length > 0
      ? { ok: false, reason: "invalid", fields }
      : { ok: false, reason: "generic" };
  }
  // The owner is the signed-in teacher, never anything the client sent. The service connection
  // writes (the `authenticated` role may not insert versions); every statement names owner_id.
  const ownerId = authorization.data.userId;
  const { questionId } = request.data;

  try {
    const result = await editQuestion(getDb(), {
      ownerId,
      questionId,
      expectedRowVersion: request.data.expectedRowVersion,
      content: content.data,
      now: new Date(),
    });
    if (!result.ok) {
      const failure = result.error;
      if (failure.code === "invalid") {
        const rows = (request.data.content as { steps?: unknown } | null)?.steps;
        return {
          ok: false,
          reason: "invalid_math",
          fields: failure.fields.map((path) => toFormPath(path, rows)),
        };
      }
      return {
        ok: false,
        reason:
          failure.code === "notFound"
            ? "not_found"
            : failure.code === "notReady"
              ? "not_ready"
              : failure.code,
      };
    }

    // Ids and the enumerated status only: never the question text.
    await audit({
      ownerId,
      action: AUDIT_QUESTION_EDITED,
      entityType: "question",
      entityId: questionId,
      metadata: { status: result.data.status },
    });
    revalidatePath(`/question-bank/${questionId}`);
    revalidatePath("/question-bank");
    return { ok: true, versionId: result.data.versionId, status: result.data.status };
  } catch (error) {
    logger.error(
      { module: "review", err: safeErrorSummary(error) },
      "review: could not save the edit",
    );
    return { ok: false, reason: "generic" };
  }
}
