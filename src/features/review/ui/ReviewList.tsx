"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { useJobStatus } from "@/lib/jobs/client/use-job-status";
import { CurriculumPanel } from "./CurriculumPanel";
import { QuestionCard } from "./QuestionCard";
import { RegenerateControl } from "./RegenerateControl";
import { SaveToBankBar } from "./SaveToBankBar";
import type { ReviewJobStatus } from "./review-client";
import type { JobState } from "./status-meta";
import { useQuestionDecision } from "./use-question-decision";
import { useRequestReview } from "./use-request-review";

function ReviewSkeleton() {
  const t = useTranslations("review");
  return (
    <section aria-busy="true" className="flex min-w-0 flex-col gap-4">
      <span className="sr-only">{t("loading")}</span>
      <ol aria-hidden="true" className="flex flex-col gap-4">
        {[0, 1, 2].map((n) => (
          <li
            key={n}
            className="flex flex-col gap-3 rounded-lg border border-l-4 border-l-transparent bg-card p-4 shadow-card motion-safe:animate-pulse"
          >
            <div className="h-4 w-1/4 rounded bg-muted" />
            <div className="h-4 w-full rounded bg-muted" />
            <div className="h-4 w-3/4 rounded bg-muted" />
            <div className="h-10 w-full rounded-lg bg-muted" />
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ReviewList({
  requestId,
  jobId,
}: {
  requestId: string;
  jobId: string | null;
}) {
  const job = useJobStatus(jobId);

  // Unknown (undefined) only while the job status is still loading for a real job. Without a job,
  // or when the job answer is signed-out/not-found, there is nothing to wait for: stop polling.
  let jobStatus: ReviewJobStatus;
  if (jobId === null) jobStatus = "stopped";
  else if (job.data?.kind === "ok") jobStatus = job.data.job.status;
  else if (job.data) jobStatus = "stopped";
  else if (job.isError) jobStatus = "unreachable";
  else jobStatus = undefined;

  const jobState: JobState =
    jobStatus === "stopped" ||
    jobStatus === "succeeded" ||
    jobStatus === "failed" ||
    jobStatus === "cancelled"
      ? "finished"
      : jobStatus === "deferred"
        ? "deferred"
        : "running";
  const query = useRequestReview(requestId, jobStatus);
  const { refetch } = query;
  // A finished regeneration or a restore changed a question: read the list again.
  const refreshReview = useCallback(() => {
    void refetch();
  }, [refetch]);
  const decision = useQuestionDecision(requestId);

  const review = query.data?.kind === "ok" ? query.data.review : null;
  const hasQuestions = review !== null && review.questions.length > 0;
  const t = useTranslations("review");
  const tStatus = useTranslations("generate.status");
  const approvedCount =
    review?.questions.filter((q) => q.decision === "approved").length ?? 0;
  const readyCount =
    review?.questions.filter((q) => q.decision === "approved" && !q.banked).length ?? 0;

  // The list is fetched once the job has finished and takes a moment: show a placeholder meanwhile
  // (S-20). Not while the job still runs (no list yet by design) or after a failed load.
  const loading = jobStatus === "succeeded" && !query.data && !query.isError;

  // The live region stays mounted (empty) so the first count is announced when it is filled.
  return (
    <>
      <div role="status" className="sr-only">
        {hasQuestions ? t("ready", { count: review.questions.length }) : ""}
      </div>
      {loading && <ReviewSkeleton />}
      {!loading && !review && query.isError && jobStatus === "succeeded" && (
        <p className="text-sm text-muted-foreground">{tStatus("reconnecting")}</p>
      )}
      {hasQuestions && (
        <section
          aria-labelledby="review-heading"
          className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4"
        >
          <h2 id="review-heading" className="font-heading text-xl font-bold">
            {t("heading")}
          </h2>
          <p className="rounded-lg border bg-accent/60 p-3 text-sm font-medium text-secondary-foreground">
            {t("disclaimer")}
          </p>
          {review.questions.length < review.requested && (
            <p className="text-sm text-muted-foreground">
              {t("showing", {
                shown: review.questions.length,
                requested: review.requested,
              })}
            </p>
          )}
          {query.isError && (
            <p className="text-sm text-muted-foreground">{tStatus("reconnecting")}</p>
          )}
          {review.curriculum && <CurriculumPanel curriculum={review.curriculum} />}
          <ol className="flex flex-col gap-4">
            {review.questions.map((question, index) => (
              <li key={question.questionId}>
                <QuestionCard
                  number={index + 1}
                  question={question}
                  jobState={jobState}
                  onDecide={(action, overrideNote) =>
                    void decision.decide(question, action, overrideNote)
                  }
                  pending={decision.isPending(question.questionId)}
                  error={decision.errorFor(question.questionId)}
                  editHref={
                    jobState === "finished" && !question.banked
                      ? `/question-bank/${question.questionId}/edit?next=${encodeURIComponent(`/generate/${requestId}`)}`
                      : undefined
                  }
                  footer={
                    jobState === "finished" ? (
                      <RegenerateControl question={question} onSettled={refreshReview} />
                    ) : undefined
                  }
                />
              </li>
            ))}
          </ol>
          <SaveToBankBar
            requestId={requestId}
            readyCount={readyCount}
            approvedCount={approvedCount}
            totalCount={review.questions.length}
          />
        </section>
      )}
    </>
  );
}
