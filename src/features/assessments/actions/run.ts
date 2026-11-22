// What every item and section action does around its service call: authorize, run under RLS as the
// signed-in teacher, map the typed failure, log only error names, and refresh the pages.
import "server-only";
import { revalidatePath } from "next/cache";
import type { authorizeAction } from "@/features/auth";
import { runAsUser } from "@/lib/db/client";
import { safeErrorSummary } from "@/lib/db/error-summary";
import { getDb } from "@/lib/db/runtime";
import { logger } from "@/lib/logger";
import type { Result } from "@/lib/result";
import type { AssessmentDb } from "../service/lock";
import type { ActionFailureReason, ActionResult, DetailedFailure } from "./result";

export async function runWrite<T, E extends ActionFailureReason | DetailedFailure>(
  // The guard itself, handed in by the action (the route-guard inventory looks for it there).
  authorize: typeof authorizeAction,
  write: (tx: AssessmentDb, ownerId: string) => Promise<Result<T, E>>,
  describe: (data: T) => object = () => ({}),
): Promise<ActionResult> {
  const authorization = await authorize();
  if (!authorization.ok) return { ok: false, reason: "unauthenticated" };
  const ownerId = authorization.data.userId;
  try {
    const result = await runAsUser(getDb(), ownerId, (tx) =>
      write(tx as unknown as AssessmentDb, ownerId),
    );
    if (!result.ok) {
      const failure: ActionFailureReason | DetailedFailure = result.error;
      if (typeof failure === "string") return { ok: false, reason: failure };
      const { code, ...detail } = failure;
      return { ok: false, reason: code, ...detail };
    }
    revalidatePath("/assessment-builder", "layout");
    return { ok: true, ...describe(result.data) };
  } catch (error) {
    // The error message may carry the SQL parameters: log the name and code only.
    logger.error(
      { module: "assessments", err: safeErrorSummary(error) },
      "assessments: could not write",
    );
    return { ok: false, reason: "generic" };
  }
}

/** A Server Action argument comes from the client: it may be anything, including null. */
export const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null;
