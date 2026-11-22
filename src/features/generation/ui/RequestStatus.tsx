"use client";

import { useLocale, useTimeZone, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { describeJobStatus } from "@/features/generation/service/status-message";
import { DEFAULT_TIMEZONE } from "@/lib/timezone-shared";
import { useJobStatus } from "@/lib/jobs/client/use-job-status";
import { useReviewLoaded } from "@/features/review/ui/use-review-loaded";

function Alert({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-lg border border-warning/40 bg-warning-soft p-4 text-sm text-warning-foreground"
    >
      {children}
    </p>
  );
}

function Body({ requestId, jobId }: { requestId: string; jobId: string | null }) {
  const query = useJobStatus(jobId);
  const list = useReviewLoaded(requestId);
  const t = useTranslations("generate.status");
  const view = { locale: useLocale(), timeZone: useTimeZone() ?? DEFAULT_TIMEZONE };

  if (jobId === null) return <Alert>{t("notFound")}</Alert>;

  const data = query.data;
  if (data?.kind === "signed-out") return <Alert>{t("signedOut")}</Alert>;
  if (data?.kind === "not-found") return <Alert>{t("notFound")}</Alert>;

  if (!data) {
    return (
      <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground shadow-card">
        {query.isError ? t("reconnecting") : t("loading")}
      </p>
    );
  }

  const message = describeJobStatus(data.job, t, view);
  // The question list is fetched after the job finishes; do not point at it before it exists. If
  // its load failed, drop the "loading" claim (the list shows its own reconnecting notice).
  if (data.job.status === "succeeded" && !list.loaded && !list.isError) {
    message.detail = t("succeededLoadingDetail");
  }
  if (message.tone === "error") {
    return (
      <div
        role="alert"
        className="flex flex-col gap-1 rounded-lg border border-destructive/30 bg-destructive-soft p-4 text-destructive-foreground"
      >
        <p className="font-heading font-semibold">{message.title}</p>
        {message.detail && (
          <p className="text-sm text-muted-foreground">{message.detail}</p>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-4 shadow-card">
      <p className="font-heading font-semibold">{message.title}</p>
      {message.detail && (
        <p className="text-sm text-muted-foreground">{message.detail}</p>
      )}
      {/* A failed refetch keeps the last known status; say that it may be out of date. */}
      {query.isError && (
        <p className="text-sm text-muted-foreground">{t("reconnecting")}</p>
      )}
    </div>
  );
}

// One persistent polite live region wraps every state, so changes (loading, running, deferred,
// finished) are announced from the same element instead of from freshly mounted ones. Error states
// carry their own inner role="alert" so they are still announced assertively.
export function RequestStatus({
  requestId,
  jobId,
}: {
  requestId: string;
  jobId: string | null;
}) {
  return (
    <div role="status">
      <Body requestId={requestId} jobId={jobId} />
    </div>
  );
}
