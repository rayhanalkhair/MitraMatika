"use client";

import { useTranslations } from "next-intl";
import { trashMaterialAction } from "../actions/material";
import { MoveToTrashButton } from "./MoveToTrashButton";

/** Moves a learning material to the trash after a confirmation (its detail page). */
export function TrashMaterialButton({
  materialId,
  title,
}: {
  materialId: string;
  title: string;
}) {
  const t = useTranslations("trash.moveMaterial");
  return (
    <MoveToTrashButton
      entity="material"
      onTrash={() => trashMaterialAction({ id: materialId })}
      afterTrash="/materials"
      copy={{
        button: t("button"),
        buttonLabel: t("buttonLabel", { title }),
        title: t("title"),
        description: t("description"),
        cancel: t("cancel"),
        confirm: t("confirm"),
        working: t("working"),
      }}
    />
  );
}
