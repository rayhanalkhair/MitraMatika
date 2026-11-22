"use server";

import { z } from "zod";
import { authorizeAction } from "@/features/auth";
import {
  AUDIT_REGENERATION_REQUESTED,
  regenerateHintSchema,
  requestRegeneration,
} from "@/features/generation";
import { getDb } from "@/lib/db/runtime";
import { audit } from "@/lib/events";
import { scheduleRun } from "@/lib/jobs/trigger";
import { logger } from "@/lib/logger";

// The wire shape the regenerate control reads: flat fields, a `reason` on failure.
export type RegenerateQuestionResult =
  | { ok: true; jobId: string; deferredUntil: string | null }
  | { ok: false; reason: "pending"; jobId: string }
  | {
      ok: false;
      reason: "daily_limit";
      limit: number;
      used: number;
      remaining: number;
      resetsAt: string;
    }
  | {
      ok: false;
      reason: "signed_out" | "not_found" | "trashed" | "not_ready" | "generic";
    };

const requestSchema = z.object({ questionId: z.uuid(), hint: regenerateHintSchema });

// A database error message carries the SQL parameters, which include the hint text. Log only the
// error name and the Postgres code.
function safeErrorSummary(error: unknown): { name: string; code: string | null } {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return {
    name: error instanceof Error ? error.name : typeof error,
    code: typeof code === "string" ? code : null,
  };
}

export async function regenerateQuestionAction(
  raw: unknown,
): Promise<RegenerateQuestionResult> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { ok: false, reason: "signed_out" };

  const request = requestSchema.safeParse(raw);
  if (!request.success) return { ok: false, reason: "generic" };
  // The owner is the signed-in teacher, never anything the client sent. The service connection
  // writes (the `authenticated` role may not insert jobs); every statement names owner_id.
  const ownerId = authorization.data.userId;
  const { questionId, hint } = request.data;

  try {
    const result = await requestRegeneration(getDb(), {
      ownerId,
      questionId,
      hint,
      now: new Date(),
    });
    if (!result.ok) {
      const failure = result.error;
      if (failure.reason === "daily_limit") {
        return {
          ok: false,
          reason: "daily_limit",
          limit: failure.limit,
          used: failure.used,
          remaining: failure.remaining,
          resetsAt: failure.resetsAt.toISOString(),
        };
      }
      if (failure.reason === "pending") {
        return { ok: false, reason: "pending", jobId: failure.jobId };
      }
      return { ok: false, reason: failure.reason };
    }

    const deferred = result.data.deferredUntil !== null;
    // The hint's kind only: the teacher's text never goes into the audit trail.
    await audit({
      ownerId,
      action: AUDIT_REGENERATION_REQUESTED,
      entityType: "question",
      entityId: questionId,
      metadata: {
        hint: hint === null ? "none" : typeof hint === "string" ? hint : "text",
        deferred,
      },
    });
    if (!deferred) {
      try {
        scheduleRun();
      } catch (error) {
        // The job is queued; the status poll, the next kick or the daily run picks it up even if
        // the immediate trigger failed.
        logger.error(
          { module: "review", err: safeErrorSummary(error) },
          "review: could not schedule the runner",
        );
      }
    }
    return {
      ok: true,
      jobId: result.data.jobId,
      deferredUntil: result.data.deferredUntil?.toISOString() ?? null,
    };
  } catch (error) {
    logger.error(
      { module: "review", err: safeErrorSummary(error) },
      "review: could not queue the regeneration",
    );
    return { ok: false, reason: "generic" };
  }
}
