// A client component through its importers (ReviewList, BankRegenerate), which are "use client"
// modules; its own function props never cross the server boundary.
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useFormatter, useLocale, useTimeZone, useTranslations } from "next-intl";
import { RefreshCw } from "lucide-react";
import { restoreVersionAction } from "@/features/bank/actions/restore-version";
import {
  describeJobStatus,
  HINT_TEXT_MAX,
} from "@/features/generation/ui/regenerate-client";
import { isTerminal } from "@/lib/jobs/client/status";
import { useJobStatus } from "@/lib/jobs/client/use-job-status";
import { DEFAULT_TIMEZONE } from "@/lib/timezone-shared";
import {
  regenerateQuestionAction,
  type RegenerateQuestionResult,
} from "../actions/regenerate-question";
import type { ReviewQuestion } from "../service/review";
import { VersionCompare } from "./VersionCompare";

const BUTTON =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60";
const SECONDARY = `${BUTTON} border border-input bg-card text-foreground hover:bg-secondary`;
const PRIMARY = `${BUTTON} bg-primary text-primary-foreground hover:bg-primary-hover`;

const CHOICES = ["none", "easier", "harder", "otherContext", "text"] as const;
type Choice = (typeof CHOICES)[number];

type Failure = Extract<RegenerateQuestionResult, { ok: false }>;

/**
 * "Regenerate" for one question: an optional hint, the job's progress (deferral with its resume
 * time included), then the old version next to the new one with "keep new" (default) or "restore
 * previous". `onSettled` refreshes the question once the job (or a restore) has finished; it gets
 * the job's last step.
 */
export function RegenerateControl({
  question,
  onSettled,
  compareHeadingLevel = 4,
}: {
  question: ReviewQuestion;
  onSettled: (step?: string) => void;
  // The comparison's heading level: one under the card's own heading.
  compareHeadingLevel?: 3 | 4;
}) {
  const t = useTranslations("review.regenerate");
  const tStatus = useTranslations("generate.status");
  const format = useFormatter();
  const view = { locale: useLocale(), timeZone: useTimeZone() ?? DEFAULT_TIMEZONE };
  const panelId = useId();
  const textId = useId();
  const countId = useId();

  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<Choice>("none");
  const [text, setText] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  // The version shown when the regeneration was asked for: the left side of the comparison.
  const [previous, setPrevious] = useState<ReviewQuestion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, startSending] = useTransition();
  const [restoring, startRestoring] = useTransition();
  // Where focus goes after the next render, when the element that had it is gone.
  const toggleRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const focusNext = useRef<"toggle" | "status" | null>(null);
  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    (target === "toggle" ? toggleRef.current : statusRef.current)?.focus();
  });

  const status = useJobStatus(jobId);
  // Only this control's job: never another job's answer cached under a different key.
  const job =
    jobId !== null && status.data?.kind === "ok" && status.data.job.id === jobId
      ? status.data.job
      : null;
  const finished = job !== null && isTerminal(job.status);
  const step = typeof job?.progress?.step === "string" ? job.progress.step : undefined;

  // Refresh the question once per finished job.
  const settled = useRef<string | null>(null);
  useEffect(() => {
    if (job && finished && settled.current !== job.id) {
      settled.current = job.id;
      onSettled(job.status === "succeeded" ? step : undefined);
    }
  }, [job, finished, step, onSettled]);

  const comparing =
    previous !== null &&
    job?.status === "succeeded" &&
    step === "saved" &&
    question.versionId !== previous.versionId;

  function failureMessage(failure: Failure): string {
    switch (failure.reason) {
      case "daily_limit":
        return t("errors.dailyLimit", {
          limit: String(failure.limit),
          time: format.dateTime(new Date(failure.resetsAt), {
            dateStyle: "long",
            timeStyle: "short",
          }),
        });
      case "not_ready":
        return t("errors.notReady");
      case "not_found":
        return t("errors.notFound");
      case "trashed":
        return t("errors.trashed");
      case "signed_out":
        return t("errors.signedOut");
      default:
        return t("errors.generic");
    }
  }

  function submit() {
    const trimmed = text.trim();
    const hint =
      choice === "none"
        ? null
        : choice === "text"
          ? trimmed
            ? { text: trimmed.slice(0, HINT_TEXT_MAX) }
            : null
          : choice;
    const before = question;
    startSending(async () => {
      const result = await regenerateQuestionAction({
        questionId: before.questionId,
        hint,
      });
      if (result.ok || result.reason === "pending") {
        setPrevious(before);
        setJobId(result.jobId);
        // The form (and the button that had focus) goes away; the toggle is disabled meanwhile.
        focusNext.current = "status";
        setOpen(false);
        setError(null);
        setNotice(null);
        return;
      }
      setError(failureMessage(result));
    });
  }

  function keepNew() {
    focusNext.current = "toggle";
    setPrevious(null);
    setJobId(null);
  }

  function restorePrevious() {
    if (!previous) return;
    const target = previous;
    startRestoring(async () => {
      const result = await restoreVersionAction({
        questionId: question.questionId,
        versionId: target.versionId,
        expectedRowVersion: question.rowVersion,
      });
      if (result.ok) {
        setPrevious(null);
        setJobId(null);
        setError(null);
        setNotice(t("compare.restored"));
        focusNext.current = "toggle";
        onSettled();
        return;
      }
      setError(
        result.reason === "stale"
          ? t("compare.stale")
          : result.reason === "signed_out"
            ? t("errors.signedOut")
            : t("compare.error"),
      );
    });
  }

  let statusText: string | null = null;
  if (jobId !== null && !comparing) {
    if (!job) statusText = t("status.starting");
    else if (job.status === "queued") statusText = t("status.queued");
    else if (job.status === "running") statusText = t("status.running");
    else if (job.status === "deferred") {
      // The generation page's own wording: the resume time comes from the job's run_after.
      statusText = describeJobStatus(job, tStatus, view).title;
    } else if (job.status === "failed" || job.status === "cancelled") {
      statusText = t("status.failed");
    } else if (step === "skipped") statusText = t("status.skipped");
    else if (step === "returned_to_review") statusText = t("status.returned");
    else statusText = t("status.saved");
  }
  const busy = sending || (jobId !== null && !finished);

  return (
    <div className="flex min-w-0 flex-col gap-3 border-t pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          ref={toggleRef}
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          disabled={busy}
          onClick={() => {
            setOpen((value) => !value);
            setError(null);
          }}
          className={SECONDARY}
        >
          <RefreshCw aria-hidden="true" className="size-4" />
          {t("action")}
        </button>
      </div>

      {open && (
        <form
          id={panelId}
          aria-label={t("heading")}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          className="flex min-w-0 flex-col gap-3 rounded-lg border bg-background p-3 sm:p-4"
        >
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="mb-1 text-sm font-semibold">{t("hintLegend")}</legend>
            <div className="flex flex-wrap gap-2">
              {CHOICES.map((value) => (
                <label
                  key={value}
                  className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border bg-card px-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-accent"
                >
                  <input
                    type="radio"
                    name={`${panelId}-hint`}
                    value={value}
                    checked={choice === value}
                    onChange={() => {
                      setChoice(value);
                    }}
                    className="size-4 accent-primary"
                  />
                  {t(`hints.${value}`)}
                </label>
              ))}
            </div>
          </fieldset>
          {choice === "text" && (
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor={textId} className="text-sm font-semibold">
                {t("textLabel")}
              </label>
              <textarea
                id={textId}
                rows={3}
                maxLength={HINT_TEXT_MAX}
                value={text}
                aria-describedby={countId}
                onChange={(event) => {
                  setText(event.target.value.slice(0, HINT_TEXT_MAX));
                }}
                className="w-full min-w-0 rounded-lg border bg-card px-3 py-2 text-sm"
              />
              <p id={countId} className="text-xs text-muted-foreground">
                {t("textCount", {
                  count: String(text.length),
                  max: String(HINT_TEXT_MAX),
                })}
              </p>
            </div>
          )}
          <p className="text-sm text-muted-foreground">{t("note")}</p>
          <div className="flex flex-wrap justify-end gap-3">
            <button
              type="button"
              onClick={() => {
                focusNext.current = "toggle";
                setOpen(false);
              }}
              className={SECONDARY}
            >
              {t("cancel")}
            </button>
            <button type="submit" disabled={sending} className={PRIMARY}>
              {sending ? t("submitting") : t("submit")}
            </button>
          </div>
        </form>
      )}

      {/* One persistent polite region, so each change of the job is announced from the same node. */}
      <div
        ref={statusRef}
        role="status"
        tabIndex={-1}
        className="text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {statusText && (
          <p className="rounded-lg border bg-card p-3 text-muted-foreground">
            {statusText}
          </p>
        )}
        {notice && !statusText && (
          <p className="rounded-lg border bg-card p-3 text-muted-foreground">{notice}</p>
        )}
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-warning-foreground"
        >
          {error}
        </p>
      )}

      {comparing && (
        <VersionCompare
          previous={previous}
          current={question}
          onKeep={keepNew}
          onRestore={restorePrevious}
          restoring={restoring}
          headingLevel={compareHeadingLevel}
        />
      )}
    </div>
  );
}
