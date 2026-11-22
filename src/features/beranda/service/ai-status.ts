import { describeJobStatus, type StatusMessage } from "@/features/generation";
import type { ViewerFormat } from "@/lib/format-date";
import type { Translator } from "@/lib/i18n/translator";
import type { RunningItem } from "@/features/beranda/service/dashboard";

// The wording of a running item comes from the same function the request status page uses.
// A deferred job without a resume time cannot happen in the read model, but must never throw.
export function jobMessage(
  item: RunningItem,
  t: Translator<"generate.status">,
  view: ViewerFormat,
  now: Date = new Date(),
): StatusMessage {
  const progress: Record<string, unknown> = { ...item.progress };
  if (item.messageKey) progress.messageKey = item.messageKey;
  if (item.jobStatus === "deferred" && item.runAfter) {
    return describeJobStatus(
      { status: "deferred", progress, error: null, runAfter: item.runAfter },
      t,
      view,
      now,
    );
  }
  return describeJobStatus(
    {
      status: item.jobStatus === "running" ? "running" : "queued",
      progress: item.progress ? progress : null,
      error: null,
      runAfter: item.runAfter ?? "",
    },
    t,
    view,
  );
}

export interface AiStatus {
  kind: "waiting" | "working" | "ready";
  detail?: string;
}

// Honest order: deferred beats working beats ready. The deferred job is always one of the running
// rows and that row carries the resume wording, so the status line keeps only its heading (S-04).
export function aiStatus(running: RunningItem[]): AiStatus {
  if (running.some((r) => r.jobStatus === "deferred")) return { kind: "waiting" };
  if (running.length > 0) return { kind: "working" };
  return { kind: "ready" };
}
