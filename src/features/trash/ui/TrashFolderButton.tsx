"use client";

import { useTranslations } from "next-intl";
import { trashFolderAction } from "../actions/material";
import { MoveToTrashButton } from "./MoveToTrashButton";

/**
 * Moves an empty material folder to the trash after a confirmation (the materials page). The list
 * then shows all materials again, since the folder being viewed is gone.
 */
export function TrashFolderButton({
  folderId,
  name,
}: {
  folderId: string;
  name: string;
}) {
  const t = useTranslations("trash.moveFolder");
  return (
    <MoveToTrashButton
      entity="folder"
      onTrash={() => trashFolderAction({ id: folderId })}
      afterTrash="/materials"
      copy={{
        button: t("button"),
        buttonLabel: t("buttonLabel", { name }),
        title: t("title"),
        description: t("description"),
        cancel: t("cancel"),
        confirm: t("confirm"),
        working: t("working"),
      }}
    />
  );
}
