// Shared by the trash Server Actions.
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { authorizeAction } from "@/features/auth";
import { audit } from "@/lib/events";
import { logger } from "@/lib/logger";
import type { Result } from "@/lib/result";
import { safeErrorSummary } from "../service/error-summary";
import type { InUse, TrashFailure } from "../service/retention";

export const AUDIT_QUESTION_TRASHED = "question_trashed";
export const AUDIT_QUESTION_UNTRASHED = "question_untrashed";
export const AUDIT_QUESTION_DELETED = "question_deleted";

// The wire shape the client reads. `in_use`: a permanent delete refused while assessments still
// use the question or template (their titles, for the message).
export type TrashActionResult =
  // `defaultDropped`: a restored template came back as a plain one (another is the default).
  | { ok: true; defaultDropped?: true }
  | {
      ok: false;
      reason: "signed_out" | "not_found" | "not_in_trash" | "not_empty" | "generic";
    }
  | { ok: false; reason: "in_use"; assessments: string[] };

export const TRASH_REASONS = {
  notFound: "not_found",
  notInTrash: "not_in_trash",
  // A folder that still holds materials or subfolders is not moved to the trash.
  notEmpty: "not_empty",
} as const;

type Refusal = TrashFailure | "notEmpty" | InUse;

/** The wire form of a refused trash operation. */
export function refusal(failure: Refusal): TrashActionResult {
  if (typeof failure === "string") return { ok: false, reason: TRASH_REASONS[failure] };
  return { ok: false, reason: "in_use", assessments: failure.assessments };
}

export { safeErrorSummary } from "../service/error-summary";

const idSchema = z.object({ id: z.uuid() });

/**
 * One trash operation of the signed-in teacher on one row: authorise, validate the id, run as that
 * owner only (never an owner the client sent), audit ids (and counts) only, refresh the pages that
 * show the row. Database and storage errors come back as `generic`, logged without SQL.
 */
export async function runTrashAction<T>(
  raw: unknown,
  spec: {
    /** The guard, named in each action's own body so the route-guard inventory sees it. */
    authorize: typeof authorizeAction;
    entityType: "assessment" | "template" | "material" | "folder" | "solver_session";
    auditAction: string;
    run: (ownerId: string, id: string) => Promise<Result<T, Refusal>>;
    metadata?: (data: T) => Record<string, number>;
    /** Work to start once the change is saved (never fails the action). */
    after?: (data: T) => void;
    /** What of the outcome the client needs to word its message. */
    reply?: (data: T) => { defaultDropped?: true };
    revalidate: (id: string) => string[];
    failure: string;
  },
): Promise<TrashActionResult> {
  const authorization = await spec.authorize();
  if (!authorization.ok) return { ok: false, reason: "signed_out" };
  const request = idSchema.safeParse(raw);
  if (!request.success) return { ok: false, reason: "generic" };
  const ownerId = authorization.data.userId;
  const { id } = request.data;
  try {
    const result = await spec.run(ownerId, id);
    if (!result.ok) return refusal(result.error);
    await audit({
      ownerId,
      action: spec.auditAction,
      entityType: spec.entityType,
      entityId: id,
      ...(spec.metadata ? { metadata: spec.metadata(result.data) } : {}),
    });
    for (const path of spec.revalidate(id)) revalidatePath(path);
    try {
      spec.after?.(result.data);
    } catch {
      // Follow-up work (starting the runner) is retried by a status poll or the daily run.
    }
    return { ok: true, ...spec.reply?.(result.data) };
  } catch (error) {
    logger.error({ module: "trash", err: safeErrorSummary(error) }, spec.failure);
    return { ok: false, reason: "generic" };
  }
}
