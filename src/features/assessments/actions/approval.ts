"use server";

import { authorizeAction } from "@/features/auth";
import { approve, reopen } from "../service/approval";
import { isUuid } from "../service/lock";
import type { ActionResult } from "./result";
import { isObject, runWrite } from "./run";

const invalid = { ok: false, reason: "invalid" } as const;
const HASH = /^[0-9a-f]{64}$/;

/**
 * Approves the assessment the teacher saw: `expectedHash` is the snapshot hash the page showed, so
 * a change made elsewhere since then is a `conflict`. The server recomputes everything under the
 * row lock; every problem comes back with `notReady`.
 */
export async function approveAction(input: {
  assessmentId: string;
  expectedHash: string;
}): Promise<ActionResult> {
  if (!isObject(input) || !isUuid(input.assessmentId)) return invalid;
  if (typeof input.expectedHash !== "string" || !HASH.test(input.expectedHash))
    return invalid;
  const { assessmentId, expectedHash } = input;
  return runWrite(authorizeAction, (tx, ownerId) =>
    approve(tx, { ownerId, assessmentId, expectedHash }),
  );
}

/** Clears the approval so the assessment can be edited again. */
export async function reopenAction(input: {
  assessmentId: string;
}): Promise<ActionResult> {
  if (!isObject(input) || !isUuid(input.assessmentId)) return invalid;
  const { assessmentId } = input;
  return runWrite(authorizeAction, (tx, ownerId) =>
    reopen(tx, { ownerId, assessmentId }),
  );
}
