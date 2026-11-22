"use server";

import { revalidatePath } from "next/cache";
import { authorizeAction } from "@/features/auth";
import { runAsUser } from "@/lib/db/client";
import { safeErrorSummary } from "@/lib/db/error-summary";
import { getDb } from "@/lib/db/runtime";
import { logger } from "@/lib/logger";
import { parseAssessmentForm, type AssessmentFormState } from "../schema/assessment";
import { updateAssessment } from "../service/assessments";
import { isUuid, type AssessmentDb } from "../service/lock";

// The editor's details form. The assessment id and the row version the teacher saw come from the
// form; the service checks the owner, the version and the approval lock.
export async function updateAssessmentAction(
  _previous: AssessmentFormState,
  data: FormData,
): Promise<AssessmentFormState> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { error: "unauthenticated" };
  const ownerId = authorization.data.userId;

  const assessmentId = data.get("assessmentId");
  if (typeof assessmentId !== "string" || !isUuid(assessmentId)) {
    return { error: "notFound" };
  }
  const expectedRowVersion = Number(data.get("expectedRowVersion"));
  if (!Number.isSafeInteger(expectedRowVersion) || expectedRowVersion < 1) {
    return { error: "conflict" };
  }

  const parsed = parseAssessmentForm(data);
  if (!parsed.ok) return { fieldErrors: parsed.error };

  try {
    const saved = await runAsUser(getDb(), ownerId, (tx) =>
      updateAssessment(tx as unknown as AssessmentDb, {
        ownerId,
        assessmentId,
        expectedRowVersion,
        input: parsed.data,
      }),
    );
    if (!saved.ok) return { error: saved.error };
    revalidatePath("/assessment-builder", "layout");
    return { savedAt: Date.now(), savedRowVersion: saved.data.rowVersion };
  } catch (error) {
    logger.error(
      { module: "assessments", err: safeErrorSummary(error) },
      "assessments: could not save the assessment",
    );
    return { error: "generic" };
  }
}
