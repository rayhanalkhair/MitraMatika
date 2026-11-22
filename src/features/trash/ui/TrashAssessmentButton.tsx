"use client";

import { useTranslations } from "next-intl";
import { trashAssessmentAction } from "../actions/assessment";
import { MoveToTrashButton } from "./MoveToTrashButton";

/**
 * Moves an assessment to the trash after a confirmation (the builder list and the editor). From
 * the editor (`afterTrash` set) the teacher goes back to the list; on the list the page re-reads.
 */
export function TrashAssessmentButton({
  assessmentId,
  title,
  afterTrash,
  compact = false,
}: {
  assessmentId: string;
  title: string;
  afterTrash?: string;
  compact?: boolean;
}) {
  const t = useTranslations("trash.moveAssessment");
  return (
    <MoveToTrashButton
      entity="assessment"
      onTrash={() => trashAssessmentAction({ id: assessmentId })}
      afterTrash={afterTrash}
      compact={compact}
      copy={{
        button: t("button"),
        buttonLabel: t("buttonLabel", { name: title }),
        title: t("title"),
        description: t("description"),
        cancel: t("cancel"),
        confirm: t("confirm"),
        working: t("working"),
      }}
    />
  );
}
