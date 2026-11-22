import { createFormatter } from "next-intl";
import type { ViewerFormat } from "@/lib/format-date";
import type { Translator } from "@/lib/i18n/translator";
import type { PublicJobStatus } from "@/lib/jobs/status";

export interface StatusMessage {
  tone: "info" | "waiting" | "success" | "error";
  title: string;
  detail?: string;
}

// "14.30" (Indonesian) or "14:30" (English): the time in the viewer's timezone, 24-hour.
export function formatResumeTime(
  iso: string,
  { locale, timeZone }: ViewerFormat,
): string {
  return createFormatter({ locale, timeZone }).dateTime(new Date(iso), {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

function progressDetail(
  progress: PublicJobStatus["progress"],
  t: Translator<"generate.status">,
): string | undefined {
  if (!progress) return undefined;
  const { done, total } = progress;
  if (typeof done === "number" && typeof total === "number" && total > 0) {
    return t("progress", { done: String(done), total: String(total) });
  }
  return undefined;
}

function failureDetail(
  code: string | undefined,
  t: Translator<"generate.status">,
): string {
  switch (code) {
    case "unknown_job_type":
      return t("failedUnknownType");
    case "provider_unavailable":
      return t("failedProviderUnavailable");
    case "provider_misconfigured":
      return t("failedProviderMisconfigured");
    case "provider_busy":
      return t("failedProviderBusy");
    case "invalid_output":
      return t("failedInvalidOutput");
    case "structural_failed":
      return t("failedStructural");
    case "persist_failed":
      return t("failedPersist");
    case "material_unrelated":
      return t("failedMaterialUnrelated");
    case "material_unavailable":
      return t("failedMaterialUnavailable");
    default:
      return t("failedGeneric");
  }
}

export function describeJobStatus(
  job: Pick<PublicJobStatus, "status" | "progress" | "error" | "runAfter">,
  t: Translator<"generate.status">,
  view: ViewerFormat,
  now: Date = new Date(),
): StatusMessage {
  switch (job.status) {
    case "queued":
      return { tone: "info", title: t("queuedTitle") };
    case "running":
      return {
        tone: "info",
        title: t("runningTitle"),
        detail: progressDetail(job.progress, t),
      };
    case "deferred": {
      // A resume time that has passed would read as a stale promise (S-03).
      if (new Date(job.runAfter).getTime() <= now.getTime()) {
        return { tone: "waiting", title: t("deferredSoonTitle") };
      }
      const time = formatResumeTime(job.runAfter, view);
      const key = job.progress?.messageKey;
      const title =
        key === "quota_minute"
          ? t("deferredMinuteTitle", { time })
          : key === "provider_rate_limited"
            ? t("deferredProviderTitle", { time })
            : t("deferredTitle", { time });
      return { tone: "waiting", title };
    }
    case "succeeded":
      return {
        tone: "success",
        title: t("succeededTitle"),
        detail: t("succeededDetail"),
      };
    case "failed":
      return {
        tone: "error",
        title: t("failedTitle"),
        detail: failureDetail(job.error?.code, t),
      };
    case "cancelled":
      return { tone: "info", title: t("cancelledTitle") };
  }
}
