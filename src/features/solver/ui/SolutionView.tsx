"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Layers, Loader, RotateCcw } from "lucide-react";
import { MathText } from "@/components/math/MathText";
import { StatusPill } from "@/components/ui/status-pill";
import {
  card,
  noticeClass,
  primaryButton,
  secondaryButton,
} from "@/features/materials/ui/styles";
import { VerificationBadge } from "@/features/review/ui/VerificationBadge";
import { isTerminal } from "@/lib/jobs/client/status";
import { useJobStatus } from "@/lib/jobs/client/use-job-status";
import { requestAlternativeAction, solveAgainAction } from "../actions/solver";
import type { SessionView, SolutionItem } from "../service/sessions";
import { useSolverErrorText } from "./error-text";
import { ExtractionConfirm } from "./ExtractionConfirm";

type Notice = { kind: "status" | "alert"; text: string } | null;

function SolutionCard({
  solution,
  index,
  checking,
}: {
  solution: SolutionItem;
  index: number;
  /** The run that cross-checks it is still live. */
  checking: boolean;
}) {
  const t = useTranslations("solve.solution");
  const id = useId();
  const { finalAnswer } = solution;
  return (
    <article aria-labelledby={`${id}-method`} className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${id}-method`} className="font-heading text-base font-bold break-words">
          {t("method", { number: index + 1, method: solution.methodLabel })}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {solution.isAlternative && (
            <StatusPill tone="neutral">{t("alternative")}</StatusPill>
          )}
          <VerificationBadge
            status={
              checking && solution.crossCheck === "pending"
                ? "checking"
                : solution.verificationStatus
            }
          />
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-1 rounded-lg bg-primary p-4 text-primary-foreground">
        <p className="text-xs font-semibold tracking-wide uppercase">
          {t("finalAnswer")}
        </p>
        <p className="font-heading text-2xl font-bold break-words">
          <MathText text={finalAnswer.value} />
          {finalAnswer.unit && <span className="ms-2 text-lg">{finalAnswer.unit}</span>}
        </p>
        <p className="text-sm">
          {finalAnswer.rounding
            ? t("rounding", { rounding: finalAnswer.rounding })
            : t("noRounding")}
        </p>
      </div>
      {solution.crossCheck === "disagree" && solution.crossCheckAnswer !== null && (
        <p role="alert" className={noticeClass("alert")}>
          {t("crossDisagree", { answer: solution.crossCheckAnswer })}
        </p>
      )}
      {solution.crossCheck === "unavailable" && (
        <p className="text-sm text-muted-foreground">{t("crossUnavailable")}</p>
      )}
      {solution.verificationStatus !== "ketidaksesuaian" && !solution.answerChecked && (
        <p className="text-sm text-muted-foreground">{t("answerUnchecked")}</p>
      )}
      <details className="group min-w-0 rounded-lg border" open={index === 0}>
        <summary className="flex min-h-11 cursor-pointer items-center px-3 font-semibold focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          {t("steps", { count: solution.steps.length })}
        </summary>
        <ol className="flex min-w-0 flex-col gap-3 border-t p-3">
          {solution.steps.map((step, stepIndex) => (
            <li key={stepIndex} className="flex min-w-0 gap-3">
              <span
                aria-hidden="true"
                className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-bold text-primary"
              >
                {stepIndex + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="sr-only">{t("stepLabel", { number: stepIndex + 1 })}</p>
                {step.title && <p className="font-semibold break-words">{step.title}</p>}
                <MathText text={step.bodyMd} className="block min-w-0 text-sm" />
              </div>
            </li>
          ))}
        </ol>
      </details>
    </article>
  );
}

/**
 * One solver session: the problem, then (while a run is live) its progress in one polite live
 * region, the confirmation of an uncertain photo reading (SOL-02), the solutions (clearest method
 * first, each with its final answer, units, rounding, verification badge and collapsible steps)
 * and "show another method" (SOL-04). A finished run refreshes the page.
 */
export function SolutionView({ session }: { session: SessionView }) {
  const t = useTranslations("solve");
  const errorText = useSolverErrorText();
  const router = useRouter();
  // A run this page asked for, until the server's view (after a refresh) names its own.
  const [requested, setRequested] = useState<{
    jobId: string;
    working: "solve" | "alternative";
  } | null>(null);
  const jobId = session.jobId ?? requested?.jobId ?? null;
  const working = session.jobId !== null ? session.working : (requested?.working ?? null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const polled = useJobStatus(jobId);
  const followed =
    jobId !== null && polled.data?.kind === "ok" && polled.data.job.id === jobId
      ? polled.data.job
      : null;
  const settled = useRef<string | null>(null);

  useEffect(() => {
    if (followed && isTerminal(followed.status) && settled.current !== followed.id) {
      settled.current = followed.id;
      router.refresh();
    }
  }, [followed, router]);

  async function run(
    action: (input: {
      sessionId: string;
    }) => Promise<{ ok: true; jobId: string } | { ok: false; error: string }>,
    kind: "solve" | "alternative",
  ) {
    setBusy(true);
    setNotice(null);
    try {
      const result = await action({ sessionId: session.id });
      if (!result.ok) {
        setNotice({ kind: "alert", text: errorText(result.error) });
        return;
      }
      settled.current = null;
      setRequested({ jobId: result.jobId, working: kind });
    } catch {
      setNotice({ kind: "alert", text: errorText("generic") });
    } finally {
      setBusy(false);
    }
  }

  const live = jobId !== null && (followed === null || !isTerminal(followed.status));
  const deferred = followed?.status === "deferred";
  const progress = !live
    ? null
    : deferred
      ? t("status.deferred")
      : working === "extract"
        ? t("status.reading")
        : working === "alternative"
          ? t("status.alternative")
          : t("status.solving");
  const confirming =
    !live &&
    (session.state === "confirm" ||
      (session.state === "failed" &&
        session.inputKind !== "text" &&
        session.problemMd === null));

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {session.problemMd !== null && (
        <section className={card} aria-labelledby={`problem-${session.id}`}>
          <h2 id={`problem-${session.id}`} className="font-heading text-lg font-bold">
            {t("solution.problemHeading")}
          </h2>
          <MathText text={session.problemMd} className="block min-w-0" />
        </section>
      )}

      <div role="status" className={progress ? noticeClass("status") : "sr-only"}>
        {progress && (
          <span className="flex items-center gap-2">
            <Loader aria-hidden="true" className="size-4 motion-safe:animate-spin" />
            {progress}
          </span>
        )}
      </div>

      {session.state === "pending" && !live && (
        <p className={noticeClass("alert")}>{t("status.pending")}</p>
      )}

      {confirming && (
        <ExtractionConfirm
          sessionId={session.id}
          extractedMd={session.extractedMd}
          issues={session.issues}
          hasPhoto={session.hasPhoto}
          readingFailed={session.state === "failed"}
        />
      )}

      {!live && session.state === "failed" && session.canSolveAgain && (
        <div role="alert" className={noticeClass("alert")}>
          <p>{t("status.failed")}</p>
        </div>
      )}
      {!live && session.canSolveAgain && (
        <button
          type="button"
          disabled={busy}
          aria-busy={busy}
          onClick={() => void run(solveAgainAction, "solve")}
          className={primaryButton}
        >
          <RotateCcw aria-hidden="true" className="size-4" />
          {t("status.solveAgain")}
        </button>
      )}

      {session.solutions.map((solution, index) => (
        <SolutionCard
          key={solution.id}
          solution={solution}
          index={index}
          checking={live}
        />
      ))}

      {session.solutions.length > 0 && !live && session.alternativeFailed && (
        <p className={noticeClass("alert")}>{t("status.alternativeFailed")}</p>
      )}
      {session.solutions.length > 0 && !live && (
        <div className="flex flex-col gap-2">
          {session.canAlternative ? (
            <button
              type="button"
              disabled={busy}
              aria-busy={busy}
              onClick={() => void run(requestAlternativeAction, "alternative")}
              className={secondaryButton}
            >
              <Layers aria-hidden="true" className="size-4" />
              {t("solution.showAnother")}
            </button>
          ) : (
            <p className="text-sm text-muted-foreground">{t("solution.noMore")}</p>
          )}
          <p className="text-xs text-muted-foreground">{t("solution.disclaimer")}</p>
        </div>
      )}

      <p
        role={notice?.kind === "alert" ? "alert" : "status"}
        className={notice ? noticeClass(notice.kind) : "sr-only"}
      >
        {notice?.text}
      </p>
    </div>
  );
}
