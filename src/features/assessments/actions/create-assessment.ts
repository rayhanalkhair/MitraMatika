"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authorizeAction } from "@/features/auth";
import { runAsUser } from "@/lib/db/client";
import { safeErrorSummary } from "@/lib/db/error-summary";
import { getDb } from "@/lib/db/runtime";
import { logger } from "@/lib/logger";
import { parseAssessmentForm, type AssessmentFormState } from "../schema/assessment";
import { createAssessment } from "../service/assessments";
import type { AssessmentDb } from "../service/lock";

// The new-assessment form on the list page: on success the teacher lands in the editor. The owner is
// the signed-in teacher; a template id from the form is checked under RLS and against the owner.
export async function createAssessmentAction(
  _previous: AssessmentFormState,
  data: FormData,
): Promise<AssessmentFormState> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { error: "unauthenticated" };
  const ownerId = authorization.data.userId;

  const parsed = parseAssessmentForm(data);
  if (!parsed.ok) return { fieldErrors: parsed.error };

  let id: string;
  try {
    const created = await runAsUser(getDb(), ownerId, (tx) =>
      createAssessment(tx as unknown as AssessmentDb, { ownerId, input: parsed.data }),
    );
    if (!created.ok) return { error: created.error };
    id = created.data.id;
  } catch (error) {
    logger.error(
      { module: "assessments", err: safeErrorSummary(error) },
      "assessments: could not create the assessment",
    );
    return { error: "generic" };
  }
  revalidatePath("/assessment-builder", "layout");
  redirect(`/assessment-builder/${id}`);
}
