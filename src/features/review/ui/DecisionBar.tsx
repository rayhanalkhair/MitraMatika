"use client";

import { useTranslations } from "next-intl";
import { Archive, Check, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DecisionAction } from "@/features/review/service/decision";
import type { ReviewQuestion } from "@/features/review/service/review";
import { OverrideDialog } from "./OverrideDialog";
import { awaitsRegeneration, type DisplayStatus, type JobState } from "./status-meta";

const baseButtonClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60";
// Setujui is the one filled action; Tolak, undo and the disabled wait button are outlined.
const approveClass = `${baseButtonClass} bg-success text-primary-foreground hover:bg-success/90`;
const buttonClass = `${baseButtonClass} border border-input bg-card text-foreground hover:bg-secondary`;

export function DecisionBar({
  question,
  displayStatus,
  jobState,
  onDecide,
  error,
  pending,
}: {
  question: ReviewQuestion;
  displayStatus: DisplayStatus;
  jobState: JobState;
  onDecide: (action: DecisionAction, overrideNote?: string) => void;
  error: string | null;
  pending: boolean;
}) {
  const t = useTranslations("review");
  const [dialogOpen, setDialogOpen] = useState(false);
  const contradiction = question.verification.status === "ketidaksesuaian";
  const checksRunning =
    displayStatus === "checking" ||
    displayStatus === "waiting" ||
    awaitsRegeneration(question.verification, jobState);

  // The decision swaps the buttons, so focus would be lost: after a decision it moves to the
  // control that comes next (undo after approve or reject, Setujui after undo).
  const approveRef = useRef<HTMLButtonElement>(null);
  const rejectRef = useRef<HTMLButtonElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<"undo" | "approve" | null>(null);
  useEffect(() => {
    const next = focusNext.current;
    if (next === "undo" && question.decision !== "draft") {
      focusNext.current = null;
      undoRef.current?.focus();
    } else if (next === "approve" && question.decision === "draft") {
      focusNext.current = null;
      (approveRef.current ?? rejectRef.current)?.focus();
    }
  }, [question.decision]);

  const decide = (action: DecisionAction, overrideNote?: string) => {
    focusNext.current = action === "reset" ? "approve" : "undo";
    if (overrideNote === undefined) onDecide(action);
    else onDecide(action, overrideNote);
  };

  if (question.banked) {
    return (
      <p className="inline-flex items-center gap-1.5 self-start rounded-full bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground">
        <Archive aria-hidden="true" className="size-4 shrink-0" />
        {t("bank.savedLabel")}
      </p>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-2 border-t pt-4">
      {question.decision === "draft" ? (
        <div className="flex flex-wrap items-center gap-3">
          {checksRunning ? (
            <button type="button" disabled className={buttonClass}>
              {t("decision.waitingChecks")}
            </button>
          ) : (
            <button
              ref={approveRef}
              type="button"
              disabled={pending}
              onClick={() => {
                if (contradiction) setDialogOpen(true);
                else decide("approve");
              }}
              className={approveClass}
            >
              <Check aria-hidden="true" className="size-4 shrink-0" />
              {contradiction ? t("decision.approveWithNote") : t("decision.approve")}
            </button>
          )}
          <button
            ref={rejectRef}
            type="button"
            disabled={pending}
            onClick={() => {
              decide("reject");
            }}
            className={buttonClass}
          >
            <X aria-hidden="true" className="size-4 shrink-0" />
            {t("decision.reject")}
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <p
            role="status"
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold ${
              question.decision === "approved"
                ? "bg-success-soft text-success-foreground"
                : "bg-destructive-soft text-destructive-foreground"
            }`}
          >
            {question.decision === "approved" ? (
              <>
                <Check aria-hidden="true" className="size-4 shrink-0" />
                {question.override
                  ? t("decision.approvedWithNote")
                  : t("decision.approved")}
              </>
            ) : (
              <>
                <X aria-hidden="true" className="size-4 shrink-0" />
                {t("decision.rejected")}
              </>
            )}
          </p>
          <button
            ref={undoRef}
            type="button"
            disabled={pending}
            onClick={() => {
              decide("reset");
            }}
            className={buttonClass}
          >
            <Undo2 aria-hidden="true" className="size-4 shrink-0" />
            {t("decision.undo")}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
      {contradiction && (
        <OverrideDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onConfirm={(note) => {
            decide("approve", note);
          }}
        />
      )}
    </div>
  );
}
