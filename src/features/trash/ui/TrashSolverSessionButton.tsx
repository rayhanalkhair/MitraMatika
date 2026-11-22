"use client";

import { useTranslations } from "next-intl";
import { trashSolverSessionAction } from "../actions/solver";
import { MoveToTrashButton } from "./MoveToTrashButton";

/** Moves a solver session to the trash after a confirmation (its page). */
export function TrashSolverSessionButton({ sessionId }: { sessionId: string }) {
  const t = useTranslations("trash.moveSolverSession");
  return (
    <MoveToTrashButton
      entity="solver_session"
      onTrash={() => trashSolverSessionAction({ id: sessionId })}
      afterTrash="/solve"
      copy={{
        button: t("button"),
        buttonLabel: t("buttonLabel"),
        title: t("title"),
        description: t("description"),
        cancel: t("cancel"),
        confirm: t("confirm"),
        working: t("working"),
      }}
    />
  );
}
