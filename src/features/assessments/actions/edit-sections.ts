"use server";

import { authorizeAction } from "@/features/auth";
import { parseSectionTitle } from "../schema/assessment";
import { isUuid } from "../service/lock";
import { addSection, removeSection, renameSection } from "../service/sections";
import type { ActionResult } from "./result";
import { isObject, runWrite } from "./run";

const invalid = { ok: false, reason: "invalid" } as const;

export async function addSectionAction(input: {
  assessmentId: string;
  title: string;
}): Promise<ActionResult<{ id: string }>> {
  if (!isObject(input)) return invalid;
  const title = parseSectionTitle(input.title);
  if (title === null || !isUuid(input.assessmentId)) return invalid;
  const { assessmentId } = input;
  return runWrite(
    authorizeAction,
    (tx, ownerId) => addSection(tx, { ownerId, assessmentId, title }),
    (data) => data,
  ) as Promise<ActionResult<{ id: string }>>;
}

export async function renameSectionAction(input: {
  sectionId: string;
  title: string;
}): Promise<ActionResult> {
  if (!isObject(input)) return invalid;
  const title = parseSectionTitle(input.title);
  if (title === null || !isUuid(input.sectionId)) return invalid;
  const { sectionId } = input;
  return runWrite(authorizeAction, (tx, ownerId) =>
    renameSection(tx, { ownerId, sectionId, title }),
  );
}

export async function removeSectionAction(input: {
  sectionId: string;
}): Promise<ActionResult> {
  if (!isObject(input) || !isUuid(input.sectionId)) return invalid;
  const { sectionId } = input;
  return runWrite(authorizeAction, (tx, ownerId) =>
    removeSection(tx, { ownerId, sectionId }),
  );
}
