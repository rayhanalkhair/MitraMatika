"use server";

import { authorizeAction } from "@/features/auth";
import { getDb } from "@/lib/db/runtime";
import { scheduleRun } from "@/lib/jobs/trigger";
import { getObjectStore } from "@/lib/storage";
import {
  deleteFolderPermanently,
  deleteMaterialPermanently,
  restoreFolder,
  restoreMaterial,
  trashFolder,
  trashMaterial,
} from "../service/material-trash";
import { runTrashAction, type TrashActionResult } from "./action-support";

/** Moves one of the signed-in teacher's learning materials to the trash for 30 days. */
export async function trashMaterialAction(raw: unknown): Promise<TrashActionResult> {
  return runTrashAction(raw, {
    authorize: authorizeAction,
    entityType: "material",
    auditAction: "material_trashed",
    run: (ownerId, materialId) =>
      trashMaterial(getDb(), { ownerId, materialId, now: new Date() }),
    revalidate: (id) => ["/materials", `/materials/${id}`, "/trash"],
    failure: "trash: could not move the material to the trash",
  });
}

/**
 * Takes one of the signed-in teacher's materials out of the trash. When its text was not fully
 * read, the ingestion was queued again and the runner starts after the response (the /trash page
 * exports maxDuration = 300). A page function carries no parser workers (R15), so the job may
 * wait there for a route function (a status poll, the finalise route or the daily run).
 */
export async function restoreMaterialAction(raw: unknown): Promise<TrashActionResult> {
  return runTrashAction(raw, {
    authorize: authorizeAction,
    entityType: "material",
    auditAction: "material_untrashed",
    run: (ownerId, materialId) =>
      restoreMaterial(getDb(), { ownerId, materialId, now: new Date() }),
    after: (outcome) => {
      if (outcome.requeued) scheduleRun();
    },
    revalidate: (id) => ["/trash", "/materials", `/materials/${id}`],
    failure: "trash: could not restore the material",
  });
}

/** Deletes one of the signed-in teacher's trashed materials for good, with its files. */
export async function deleteMaterialAction(raw: unknown): Promise<TrashActionResult> {
  return runTrashAction(raw, {
    authorize: authorizeAction,
    entityType: "material",
    auditAction: "material_deleted",
    run: (ownerId, materialId) =>
      deleteMaterialPermanently(getDb(), getObjectStore, {
        ownerId,
        materialId,
        now: new Date(),
      }),
    metadata: (counts) => ({ ...counts }),
    revalidate: () => ["/trash"],
    failure: "trash: could not delete the material",
  });
}

/** Moves one of the signed-in teacher's empty folders to the trash for 30 days. */
export async function trashFolderAction(raw: unknown): Promise<TrashActionResult> {
  return runTrashAction(raw, {
    authorize: authorizeAction,
    entityType: "folder",
    auditAction: "folder_trashed",
    run: (ownerId, folderId) =>
      trashFolder(getDb(), { ownerId, folderId, now: new Date() }),
    revalidate: () => ["/materials", "/trash"],
    failure: "trash: could not move the folder to the trash",
  });
}

/** Takes one of the signed-in teacher's folders out of the trash. */
export async function restoreFolderAction(raw: unknown): Promise<TrashActionResult> {
  return runTrashAction(raw, {
    authorize: authorizeAction,
    entityType: "folder",
    auditAction: "folder_untrashed",
    run: (ownerId, folderId) => restoreFolder(getDb(), { ownerId, folderId }),
    revalidate: () => ["/trash", "/materials"],
    failure: "trash: could not restore the folder",
  });
}

/** Deletes one of the signed-in teacher's trashed folders for good (what it held is kept). */
export async function deleteFolderAction(raw: unknown): Promise<TrashActionResult> {
  return runTrashAction(raw, {
    authorize: authorizeAction,
    entityType: "folder",
    auditAction: "folder_deleted",
    run: (ownerId, folderId) =>
      deleteFolderPermanently(getDb(), { ownerId, folderId, now: new Date() }),
    metadata: (counts) => ({ ...counts }),
    revalidate: () => ["/trash"],
    failure: "trash: could not delete the folder",
  });
}
