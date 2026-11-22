import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { ChevronDown, CircleCheck, Pencil } from "lucide-react";
import { MathText } from "@/components/math/MathText";
import type { DecisionAction } from "@/features/review/service/decision";
import type { ReviewQuestion } from "@/features/review/service/review";
import { StatusPill } from "@/components/ui/status-pill";
import { DecisionBar } from "./DecisionBar";
import { MaterialSource } from "./MaterialSource";
import { displayStatus, type JobState } from "./status-meta";
import { VerificationBadge } from "./VerificationBadge";
import { VerificationSheet } from "./VerificationSheet";

export function QuestionCard({
  number,
  question,
  jobState,
  onDecide,
  pending = false,
  error = null,
  readOnly = false,
  heading,
  editHref,
  footer,
}: {
  number: number;
  question: ReviewQuestion;
  jobState: JobState;
  onDecide?: (action: DecisionAction, overrideNote?: string) => void;
  pending?: boolean;
  error?: string | null;
  // The bank detail: the saved version without any decision control.
  readOnly?: boolean;
  // Replaces "Soal n" (the bank detail has no position in a list). The page title is the h1, so
  // the card title is an h2 there; in the review list it stays an h3 under the section h2.
  heading?: string;
  // Where the edit page for this question is; no link without it.
  editHref?: string;
  // Rendered last inside the card (the regenerate control).
  footer?: ReactNode;
}) {
  const t = useTranslations("review");
  const tEdit = useTranslations("review.edit");
  const status = displayStatus(question.verification, jobState);
  const Heading = readOnly ? "h2" : "h3";
  const headingId = `question-${question.questionId}-heading`;

  return (
    <article
      aria-labelledby={headingId}
      data-decision={question.decision}
      className={`flex min-w-0 flex-col gap-4 rounded-lg border border-l-4 p-4 shadow-card sm:p-5 ${
        question.decision === "rejected"
          ? "border-l-destructive bg-muted"
          : question.decision === "approved"
            ? "border-l-success bg-card"
            : "border-l-transparent bg-card"
      }`}
    >
      <div
        data-slot="question-header"
        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Heading id={headingId} className="font-heading text-lg font-bold">
            {heading ?? t("questionHeading", { number: String(number) })}
          </Heading>
          <StatusPill tone="neutral">{t(`difficulty.${question.difficulty}`)}</StatusPill>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {editHref && (
            <Link
              href={editHref}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-primary hover:underline"
            >
              <Pencil aria-hidden="true" className="size-4" />
              {tEdit("action")}
            </Link>
          )}
          <VerificationBadge status={status} />
          <VerificationSheet
            questionNumber={number}
            verification={question.verification}
            status={status}
          />
        </div>
      </div>

      <MathText
        text={question.stemMd}
        className="block min-w-0 overflow-x-auto break-words"
      />
      <MaterialSource sources={question.sources} />

      <ol aria-label={t("optionsLabel")} className="flex flex-col gap-2">
        {question.options.map((option) => {
          const isKey = option.label === question.correctLabel;
          return (
            <li
              key={option.label}
              className={`flex min-w-0 flex-col gap-1 rounded-lg border p-3 ${
                isKey ? "border-success bg-success-soft" : "bg-background"
              }`}
            >
              <div className="flex min-w-0 gap-2">
                <span className="font-heading font-semibold text-primary">
                  {option.label}.
                </span>
                <MathText
                  text={option.textMd}
                  className="min-w-0 overflow-x-auto break-words"
                />
              </div>
              {isKey && (
                <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-success-foreground">
                  <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
                  {t("keyLabel")}
                </span>
              )}
            </li>
          );
        })}
      </ol>

      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-sm font-medium text-muted-foreground">{t("answerLabel")}</p>
        <MathText text={question.answerDisplayMd} className="block min-w-0 break-words" />
      </div>

      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-sm font-medium text-muted-foreground">
          {t("explanationLabel")}
        </p>
        <MathText text={question.explanationMd} className="block min-w-0 break-words" />
      </div>

      <details className="group">
        <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 text-sm font-medium text-primary">
          {t("stepsSummary", { count: String(question.steps.length) })}
          <ChevronDown
            aria-hidden="true"
            className="size-4 shrink-0 transition-transform group-open:rotate-180"
          />
        </summary>
        <ol className="mt-2 flex list-decimal flex-col gap-2 pl-5 text-sm">
          {question.steps.map((step, index) => (
            <li key={index} className="min-w-0 break-words">
              <MathText text={step} />
            </li>
          ))}
        </ol>
      </details>

      {!readOnly && onDecide && (
        <DecisionBar
          question={question}
          displayStatus={status}
          jobState={jobState}
          onDecide={onDecide}
          error={error}
          pending={pending}
        />
      )}
      {footer}
    </article>
  );
}
