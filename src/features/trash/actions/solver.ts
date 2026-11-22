"use server";

import { authorizeAction } from "@/features/auth";
import { getDb } from "@/lib/db/runtime";
import { getObjectStore } from "@/lib/storage";
import {
  deleteSolverSessionPermanently,
  restoreSolverSession,
  trashSolverSession,
} from "../service/solver-trash";
import { runTrashAction, type TrashActionResult } from "./action-support";

/** Moves one of the signed-in teacher's solver sessions to the trash for 30 days. */
export async function trashSolverSessionAction(raw: unknown): Promise<TrashActionResult> {
  return runTrashAction(raw, {
    authorize: authorizeAction,
    entityType: "solver_session",
    auditAction: "solver_session_trashed",
    run: (ownerId, sessionId) =>
      trashSolverSession(getDb(), { ownerId, sessionId, now: new Date() }),
    revalidate: (id) => ["/solve", `/solve/${id}`, "/trash"],
    failure: "trash: could not move the solver session to the trash",
  });
}

/** Takes one of the signed-in teacher's solver sessions out of the trash. */
export async function restoreSolverSessionAction(
  raw: unknown,
): Promise<TrashActionResult> {
  return runTrashAction(raw, {
    authorize: authorizeAction,
    entityType: "solver_session",
    auditAction: "solver_session_untrashed",
    run: (ownerId, sessionId) => restoreSolverSession(getDb(), { ownerId, sessionId }),
    revalidate: (id) => ["/trash", "/solve", `/solve/${id}`],
    failure: "trash: could not restore the solver session",
  });
}

/** Deletes one of the signed-in teacher's trashed solver sessions for good, with its photo. */
export async function deleteSolverSessionAction(
  raw: unknown,
): Promise<TrashActionResult> {
  return runTrashAction(raw, {
    authorize: authorizeAction,
    entityType: "solver_session",
    auditAction: "solver_session_deleted",
    run: (ownerId, sessionId) =>
      deleteSolverSessionPermanently(getDb(), getObjectStore, {
        ownerId,
        sessionId,
        now: new Date(),
      }),
    metadata: (counts) => ({ ...counts }),
    revalidate: () => ["/trash"],
    failure: "trash: could not delete the solver session",
  });
}
