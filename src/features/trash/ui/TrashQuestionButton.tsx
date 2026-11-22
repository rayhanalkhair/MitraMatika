"use client";

import { useTranslations } from "next-intl";
import { trashQuestionAction } from "../actions/trash";
import { MoveToTrashButton } from "./MoveToTrashButton";

/**
 * Moves a question to the trash after a confirmation. On the detail page (`afterTrash` set) the
 * teacher is taken there, since the question has left the bank; on a bank card the list re-reads.
 * `topic` names the question in the button's accessible name, so a list of cards stays clear.
 */
export function TrashQuestionButton({
  questionId,
  topic,
  afterTrash,
  compact = false,
}: {
  questionId: string;
  topic: string;
  afterTrash?: string;
  compact?: boolean;
}) {
  const t = useTranslations("trash.move");
  return (
    <MoveToTrashButton
      entity="question"
      onTrash={() => trashQuestionAction({ questionId })}
      afterTrash={afterTrash}
      compact={compact}
      copy={{
        button: t("button"),
        buttonLabel: t("buttonLabel", { topic }),
        title: t("title"),
        description: t("description"),
        cancel: t("cancel"),
        confirm: t("confirm"),
        working: t("working"),
      }}
    />
  );
}
