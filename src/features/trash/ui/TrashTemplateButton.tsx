"use client";

import { useTranslations } from "next-intl";
import { trashTemplateAction } from "../actions/template";
import { MoveToTrashButton } from "./MoveToTrashButton";

/** Moves a school template to the trash after a confirmation (Settings, template card). */
export function TrashTemplateButton({
  templateId,
  name,
}: {
  templateId: string;
  name: string;
}) {
  const t = useTranslations("trash.moveTemplate");
  return (
    <MoveToTrashButton
      entity="template"
      onTrash={() => trashTemplateAction({ id: templateId })}
      compact
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
