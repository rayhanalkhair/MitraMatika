"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { assessmentReturnTo } from "@/lib/navigation/return-to";
import { getCurriculum } from "@/features/curriculum";
import {
  AUDIT_GENERATION_REQUESTED,
  AUDIT_QUESTION_APPROVED,
  AUDIT_QUESTION_DECISION_RESET,
  AUDIT_QUESTION_REJECTED,
  AUDIT_QUESTIONS_BANKED,
} from "@/features/generation/service/audit";
import { bankApprovedQuestions } from "@/features/bank";
import {
  decideQuestion,
  type DecisionFailure,
  type DecisionResult,
  type DecisionSuccess,
} from "@/features/review";
import { parseDecisionInput } from "@/features/review";
import type { AnyDb } from "@/features/generation/service/persist";
import type {
  GenerationErrorKey,
  GenerationFormState,
} from "@/features/generation/schema/form-state";
import type { MaterialSelectionError } from "@/features/generation/service/material-selection";
import { createGenerationRequest } from "@/features/generation/service/request";
import { parseGenerationInput } from "@/features/generation/schema/request-input";
import { authorizeAction } from "@/features/auth";
import { runAsUser } from "@/lib/db/client";
import { getDb } from "@/lib/db/runtime";
import { profiles } from "@/lib/db/schema";
import { audit, usage } from "@/lib/events";
import { scheduleRun } from "@/lib/jobs/trigger";
import { logger } from "@/lib/logger";

// Why the service refused the chosen material, as the form's message key.
const MATERIAL_ERRORS: Record<MaterialSelectionError | "unrelated", GenerationErrorKey> =
  {
    unrelated: "materialUnrelated",
    material: "materialUnknown",
    notReady: "materialNotReady",
    sections: "sectionsUnknown",
    pages: "pagesUnavailable",
    empty: "materialEmpty",
  };

export async function createGenerationRequestAction(
  _previous: GenerationFormState,
  formData: FormData,
): Promise<GenerationFormState> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { error: authorization.error };

  const parsed = parseGenerationInput(formData);
  if (!parsed.ok) {
    // The grade is a hidden field, so its error has no place to render: show the generic error instead
    // and keep any visible field errors.
    const { grade, ...visible } = parsed.errors;
    if (grade !== undefined) {
      return Object.keys(visible).length > 0
        ? { error: "generic", fieldErrors: visible }
        : { error: "generic" };
    }
    return { fieldErrors: parsed.errors };
  }
  const { topic: topicKey, count, difficulty, material } = parsed.value;

  let created: Awaited<ReturnType<typeof createGenerationRequest>>;
  try {
    // The client only names a topic; the id and the curriculum version come from the active catalogue.
    const topic = await getCurriculum().getTopic({ grade: 8, stableKey: topicKey });
    if (!topic) return { fieldErrors: { topic: "topicUnknown" } };

    const db = getDb();
    // The allow-listed sign-in normally creates the profile; make sure it exists before the first write
    // that depends on it (P1-03).
    await db
      .insert(profiles)
      .values({ id: authorization.data.userId })
      .onConflictDoNothing();

    created = await createGenerationRequest(db, {
      ownerId: authorization.data.userId,
      topic: { id: topic.id, stableKey: topic.stableKey, title: topic.title },
      curriculumVersionId: topic.version.id,
      quantity: count,
      difficulty,
      // Checked by the service for this owner (not trashed, ingested, pages readable).
      ...(material ? { material } : {}),
      now: new Date(),
    });
  } catch (error) {
    logger.error(
      { module: "generation", err: error },
      "generation: could not create the generation request",
    );
    return { error: "generic" };
  }

  if (!created.ok) {
    if (created.error.reason === "material") {
      return { fieldErrors: { material: MATERIAL_ERRORS[created.error.error] } };
    }
    if (created.error.reason === "daily_limit") {
      const { limit, used, remaining, resetsAt } = created.error;
      return { dailyLimit: { limit, used, remaining, resetsAt: resetsAt.toISOString() } };
    }
    return { activeRequestId: created.error.requestId };
  }
  const request = created.data;

  const deferred = request.deferredUntil !== null;
  await usage({
    ownerId: authorization.data.userId,
    event: "generation_requested",
    entityType: "generation_request",
    entityId: request.requestId,
    metadata: {
      quantity: count,
      difficulty,
      deferred,
      source: material ? "material" : "topic",
    },
  });
  await audit({
    ownerId: authorization.data.userId,
    action: AUDIT_GENERATION_REQUESTED,
    entityType: "generation_request",
    entityId: request.requestId,
    metadata: { quantity: count, difficulty, deferred },
  });
  if (!deferred) {
    try {
      scheduleRun();
    } catch (error) {
      // The job is queued; the status poll, the next kick or the daily run picks it up even if the
      // immediate trigger failed.
      logger.error(
        { module: "generation", err: error },
        "generation: could not schedule the runner",
      );
    }
  }

  // Created from an assessment editor: the status page keeps the way back (only an editor path).
  const rawReturn = formData.get("returnTo");
  const returnTo = typeof rawReturn === "string" ? assessmentReturnTo(rawReturn) : null;
  redirect(
    returnTo
      ? `/generate/${request.requestId}?returnTo=${encodeURIComponent(returnTo)}`
      : `/generate/${request.requestId}`,
  );
}

// A database error message carries the SQL parameters, which include the override note. Log only
// the error name and the Postgres code, never the error object or its message.
function safeErrorSummary(error: unknown): { name: string; code: string | null } {
  const read = (value: unknown): string | null => {
    const code = (value as { code?: unknown } | null | undefined)?.code;
    return typeof code === "string" ? code : null;
  };
  return {
    name: error instanceof Error ? error.name : typeof error,
    code: read(error) ?? read((error as { cause?: unknown } | null | undefined)?.cause),
  };
}

// The wire shape the client hook reads: flat fields on success, a `reason` on failure. It is not the
// service's Result shape; decideQuestionAction maps one to the other.
export type DecisionActionResult =
  | ({ ok: true } & DecisionSuccess)
  | { ok: false; reason: DecisionFailure | "signed_out" | "invalid" | "generic" };

const DECISION_AUDIT = {
  approve: AUDIT_QUESTION_APPROVED,
  reject: AUDIT_QUESTION_REJECTED,
  reset: AUDIT_QUESTION_DECISION_RESET,
} as const;

export async function decideQuestionAction(raw: unknown): Promise<DecisionActionResult> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { ok: false, reason: "signed_out" };

  const parsed = parseDecisionInput(raw);
  if (!parsed.ok) return { ok: false, reason: "invalid" };
  const input = parsed.value;
  const ownerId = authorization.data.userId;

  let result: DecisionResult;
  try {
    // Under RLS (runAsUser), never the service connection: the rules re-derive everything.
    result = await runAsUser(getDb(), ownerId, (tx) =>
      decideQuestion(tx as unknown as AnyDb, {
        ownerId,
        questionId: input.questionId,
        versionId: input.versionId,
        rowVersion: input.rowVersion,
        action: input.action,
        ...(input.overrideNote !== undefined ? { overrideNote: input.overrideNote } : {}),
        now: new Date(),
      }),
    );
  } catch (error) {
    logger.error(
      { module: "generation", err: safeErrorSummary(error) },
      "generation: could not save the decision",
    );
    return { ok: false, reason: "generic" };
  }

  if (!result.ok) return { ok: false, reason: result.error };

  // Ids, counts and flags only: the override note never goes into the audit trail.
  await audit({
    ownerId,
    action: DECISION_AUDIT[input.action],
    entityType: "question",
    entityId: input.questionId,
    metadata:
      input.action === "approve"
        ? { override: result.data.override, versionNo: result.data.versionNo }
        : { versionNo: result.data.versionNo },
  });
  return { ok: true, ...result.data };
}

export type BankActionResult =
  | { ok: true; saved: number }
  | { ok: false; reason: "signed_out" | "invalid" | "generic" };

const bankInputSchema = z.object({ requestId: z.uuid() });

export async function bankApprovedAction(raw: unknown): Promise<BankActionResult> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { ok: false, reason: "signed_out" };

  const parsed = bankInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const { requestId } = parsed.data;
  const ownerId = authorization.data.userId;

  let saved: number;
  try {
    // Under RLS (runAsUser), never the service connection.
    ({ saved } = await runAsUser(getDb(), ownerId, (tx) =>
      bankApprovedQuestions(tx as unknown as AnyDb, {
        ownerId,
        requestId,
        now: new Date(),
      }),
    ));
  } catch (error) {
    logger.error(
      { module: "generation", err: safeErrorSummary(error) },
      "generation: could not save to the bank",
    );
    return { ok: false, reason: "generic" };
  }

  if (saved > 0) {
    await audit({
      ownerId,
      action: AUDIT_QUESTIONS_BANKED,
      entityType: "generation_request",
      entityId: requestId,
      metadata: { count: saved },
    });
  }
  return { ok: true, saved };
}
