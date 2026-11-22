"use server";

import { authorizeAction } from "@/features/auth";
import { getDb } from "@/lib/db/runtime";
import { getObjectStore } from "@/lib/storage";
import {
  deleteTemplatePermanently,
  restoreTemplate,
  trashTemplate,
} from "../service/template-trash";
import { runTrashAction, type TrashActionResult } from "./action-support";

/** Moves one of the signed-in teacher's school templates to the trash for 30 days. */
export async function trashTemplateAction(raw: unknown): Promise<TrashActionResult> {
  return runTrashAction(raw, {
    authorize: authorizeAction,
    entityType: "template",
    auditAction: "template_trashed",
    run: (ownerId, templateId) =>
      trashTemplate(getDb(), { ownerId, templateId, now: new Date() }),
    revalidate: () => ["/settings", "/trash"],
    failure: "trash: could not move the template to the trash",
  });
}

/** Takes one of the signed-in teacher's templates out of the trash. */
export async function restoreTemplateAction(raw: unknown): Promise<TrashActionResult> {
  return runTrashAction(raw, {
    authorize: authorizeAction,
    entityType: "template",
    auditAction: "template_untrashed",
    run: (ownerId, templateId) => restoreTemplate(getDb(), { ownerId, templateId }),
    reply: (outcome) => (outcome.defaultDropped ? { defaultDropped: true } : {}),
    revalidate: () => ["/trash", "/settings"],
    failure: "trash: could not restore the template",
  });
}

/** Deletes one of the signed-in teacher's trashed templates for good, with its logo. */
export async function deleteTemplateAction(raw: unknown): Promise<TrashActionResult> {
  return runTrashAction(raw, {
    authorize: authorizeAction,
    entityType: "template",
    auditAction: "template_deleted",
    run: (ownerId, templateId) =>
      deleteTemplatePermanently(getDb(), getObjectStore, {
        ownerId,
        templateId,
        now: new Date(),
      }),
    metadata: (counts) => ({ ...counts }),
    revalidate: () => ["/trash"],
    failure: "trash: could not delete the template",
  });
}
