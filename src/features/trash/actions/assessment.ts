"use server";

import { authorizeAction } from "@/features/auth";
import { getDb } from "@/lib/db/runtime";
import { getObjectStore } from "@/lib/storage";
import {
  deleteAssessmentPermanently,
  restoreAssessment,
  trashAssessment,
} from "../service/assessment-trash";
import { runTrashAction, type TrashActionResult } from "./action-support";

/** Moves one of the signed-in teacher's assessments to the trash for 30 days. */
export async function trashAssessmentAction(raw: unknown): Promise<TrashActionResult> {
  return runTrashAction(raw, {
    authorize: authorizeAction,
    entityType: "assessment",
    auditAction: "assessment_trashed",
    run: (ownerId, assessmentId) =>
      trashAssessment(getDb(), { ownerId, assessmentId, now: new Date() }),
    revalidate: (id) => [
      "/assessment-builder",
      `/assessment-builder/${id}`,
      "/trash",
      "/home",
    ],
    failure: "trash: could not move the assessment to the trash",
  });
}

/** Takes one of the signed-in teacher's assessments out of the trash, as it was. */
export async function restoreAssessmentAction(raw: unknown): Promise<TrashActionResult> {
  return runTrashAction(raw, {
    authorize: authorizeAction,
    entityType: "assessment",
    auditAction: "assessment_untrashed",
    run: (ownerId, assessmentId) => restoreAssessment(getDb(), { ownerId, assessmentId }),
    revalidate: (id) => [
      "/trash",
      "/assessment-builder",
      `/assessment-builder/${id}`,
      "/home",
    ],
    failure: "trash: could not restore the assessment",
  });
}

/** Deletes one of the signed-in teacher's trashed assessments for good, with its export files. */
export async function deleteAssessmentAction(raw: unknown): Promise<TrashActionResult> {
  return runTrashAction(raw, {
    authorize: authorizeAction,
    entityType: "assessment",
    auditAction: "assessment_deleted",
    run: (ownerId, assessmentId) =>
      deleteAssessmentPermanently(getDb(), getObjectStore, {
        ownerId,
        assessmentId,
        now: new Date(),
      }),
    metadata: (counts) => ({ ...counts }),
    revalidate: () => ["/trash"],
    failure: "trash: could not delete the assessment",
  });
}
