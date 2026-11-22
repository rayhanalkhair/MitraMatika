"use server";

import { authorizeAction } from "@/features/auth";
import { addItems, moveItem, removeItem, updateItemToLatest } from "../service/items";
import { isUuid } from "../service/lock";
import type { ActionResult } from "./result";
import { isObject, runWrite } from "./run";

const invalid = { ok: false, reason: "invalid" } as const;

/** Adds the picked questions to a section, each pinned to its current version. */
export async function addItemsAction(input: {
  assessmentId: string;
  sectionId: string;
  questionIds: string[];
}): Promise<ActionResult<{ added: number; skipped: number }>> {
  if (
    !isObject(input) ||
    !isUuid(input.assessmentId) ||
    !isUuid(input.sectionId) ||
    !Array.isArray(input.questionIds) ||
    !input.questionIds.every((id) => typeof id === "string" && isUuid(id))
  ) {
    return invalid;
  }
  const { assessmentId, sectionId, questionIds } = input;
  return runWrite(
    authorizeAction,
    (tx, ownerId) => addItems(tx, { ownerId, assessmentId, sectionId, questionIds }),
    (data) => data,
  ) as Promise<ActionResult<{ added: number; skipped: number }>>;
}

export async function removeItemAction(input: { itemId: string }): Promise<ActionResult> {
  if (!isObject(input) || !isUuid(input.itemId)) return invalid;
  const { itemId } = input;
  return runWrite(authorizeAction, (tx, ownerId) => removeItem(tx, { ownerId, itemId }));
}

export async function moveItemAction(input: {
  itemId: string;
  toSectionId: string;
  toIndex: number;
}): Promise<ActionResult> {
  if (
    !isObject(input) ||
    !isUuid(input.itemId) ||
    !isUuid(input.toSectionId) ||
    !Number.isInteger(input.toIndex)
  ) {
    return invalid;
  }
  const { itemId, toSectionId, toIndex } = input;
  return runWrite(authorizeAction, (tx, ownerId) =>
    moveItem(tx, { ownerId, itemId, toSectionId, toIndex }),
  );
}

export async function updateItemToLatestAction(input: {
  itemId: string;
}): Promise<ActionResult<{ changed: boolean }>> {
  if (!isObject(input) || !isUuid(input.itemId)) return invalid;
  const { itemId } = input;
  return runWrite(
    authorizeAction,
    (tx, ownerId) => updateItemToLatest(tx, { ownerId, itemId }),
    (data) => data,
  ) as Promise<ActionResult<{ changed: boolean }>>;
}
