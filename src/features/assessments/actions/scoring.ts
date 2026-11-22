"use server";

import { authorizeAction } from "@/features/auth";
import { isUuid } from "../service/lock";
import { pointsFormSchema } from "../schema/assessment";
import { SCORING_MODES, type ScoringMode } from "../service/scoring";
import { setPoints, setScoringMode, setShuffle } from "../service/settings";
import type { ActionResult } from "./result";
import { isObject, runWrite } from "./run";

const invalid = { ok: false, reason: "invalid" } as const;

export async function setScoringModeAction(input: {
  assessmentId: string;
  mode: ScoringMode;
}): Promise<ActionResult> {
  if (!isObject(input) || !isUuid(input.assessmentId)) return invalid;
  const mode = SCORING_MODES.find((value) => value === input.mode);
  if (!mode) return invalid;
  const { assessmentId } = input;
  return runWrite(authorizeAction, (tx, ownerId) =>
    setScoringMode(tx, { ownerId, assessmentId, mode }),
  );
}

/**
 * The teacher's points per item, as typed (strings in the locale's notation), keyed by item id;
 * parsed with the form's own schema. All or nothing.
 */
export async function setPointsAction(input: {
  assessmentId: string;
  points: Record<string, string>;
}): Promise<ActionResult> {
  if (!isObject(input) || !isUuid(input.assessmentId) || !isObject(input.points)) {
    return invalid;
  }
  const entries = Object.entries(input.points);
  if (
    Array.isArray(input.points) ||
    entries.some(([itemId, typed]) => !isUuid(itemId) || typeof typed !== "string")
  ) {
    return invalid;
  }
  const parsed = pointsFormSchema.safeParse({ points: input.points });
  if (!parsed.success) return { ok: false, reason: "invalidPoints" };
  const points = Object.entries(parsed.data).map(([itemId, value]) => ({
    itemId,
    points: value,
  }));
  const { assessmentId } = input;
  return runWrite(authorizeAction, (tx, ownerId) =>
    setPoints(tx, { ownerId, assessmentId, points }),
  );
}

/** Shuffle on (a server-made seed), off, or reshuffle (a new seed). */
export async function setShuffleAction(input: {
  assessmentId: string;
  mode: "on" | "off" | "reshuffle";
}): Promise<ActionResult> {
  if (!isObject(input) || !isUuid(input.assessmentId)) return invalid;
  const mode = (["on", "off", "reshuffle"] as const).find(
    (value) => value === input.mode,
  );
  if (!mode) return invalid;
  const { assessmentId } = input;
  return runWrite(authorizeAction, (tx, ownerId) =>
    setShuffle(tx, { ownerId, assessmentId, mode }),
  );
}
