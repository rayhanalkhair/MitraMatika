"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { AlertTriangle, Download, FileDown, RefreshCw } from "lucide-react";
import { primaryButton, secondaryButton } from "@/features/assessments/ui/styles";
import { isTerminal } from "@/lib/jobs/client/status";
import { useJobStatus } from "@/lib/jobs/client/use-job-status";
import type { JobStatusValue } from "@/lib/jobs/status";
import { startExportAction } from "../actions/start-export";
import type { StartExportResult } from "../actions/result";
import type {
  ExportPanelData,
  ExportPanelFile,
  PanelWarning,
} from "../service/export-panel";
import type { WarningWhere } from "../service/rich-text";

const ACTIVE: readonly JobStatusValue[] = ["queued", "running", "deferred"];
const DOCUMENTS = ["paper", "key", "solutions", "zip"] as const;

type Failure = Extract<StartExportResult, { ok: false }>;
type Translate = ReturnType<typeof useTranslations<"assessments.export">>;
type TranslateWhere = ReturnType<typeof useTranslations<"assessments.preview">>;

// The job failure codes of export-job.ts, as message keys.
const ERROR_KEYS: Record<
  string,
  | "notApproved"
  | "notFound"
  | "stale"
  | "tooLarge"
  | "rendererUnavailable"
  | "renderFailed"
> = {
  export_not_approved: "notApproved",
  export_not_found: "notFound",
  export_stale: "stale",
  export_too_large: "tooLarge",
  export_renderer_unavailable: "rendererUnavailable",
  export_render_failed: "renderFailed",
};

function whereText(t: TranslateWhere, where: WarningWhere): string {
  switch (where.part) {
    case "stem":
      return t("where.stem", { number: where.number ?? 0 });
    case "option":
      return t("where.option", { number: where.number, label: where.label });
    case "step":
      return t("where.step", { number: where.number, step: where.step });
    case "sectionInstructions":
      return t("where.sectionInstructions", { section: where.section });
    case "instructions":
      return t("where.instructions");
  }
}

/**
 * The export panel of an approved assessment (decision 11): "Export documents" queues the job and
 * follows it like the generation page does; once done, the six documents and the ZIP with their
 * expiry date, and what the teacher should check (a formula written as text, an omitted logo).
 * After the 7 days the files are gone and the panel offers a new export.
 */
export function ExportPanel({
  assessmentId,
  data,
}: {
  assessmentId: string;
  data: ExportPanelData;
}) {
  const t = useTranslations("assessments.export");
  const tWhere = useTranslations("assessments.preview");
  const format = useFormatter();
  const router = useRouter();
  const headingId = useId();
  const statusRef = useRef<HTMLParagraphElement>(null);
  const focusStatus = useRef(false);

  const initialJob = data.job && ACTIVE.includes(data.job.status) ? data.job.id : null;
  const [jobId, setJobId] = useState<string | null>(initialJob);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [sending, startSending] = useTransition();

  const status = useJobStatus(jobId);
  const job =
    jobId !== null && status.data?.kind === "ok" && status.data.job.id === jobId
      ? status.data.job
      : null;

  // A finished job: show its files (a fresh render of the page) or its failure.
  const settled = useRef<string | null>(null);
  useEffect(() => {
    if (job && isTerminal(job.status) && settled.current !== job.id) {
      settled.current = job.id;
      router.refresh();
    }
  }, [job, router]);

  useEffect(() => {
    if (focusStatus.current) {
      focusStatus.current = false;
      statusRef.current?.focus();
    }
  });

  // The poll stops on a signed-out or unknown job: the panel must not wait for it forever.
  const lost =
    jobId !== null &&
    (status.data?.kind === "signed-out" || status.data?.kind === "not-found")
      ? status.data.kind
      : null;
  const running =
    jobId !== null && lost === null && (job === null || !isTerminal(job.status));
  // The failure of the newest job: the one just followed, else the one the page was rendered with.
  const failedCode =
    job?.status === "failed"
      ? (job.error?.code ?? "")
      : jobId === null && data.job?.status === "failed"
        ? (data.job.errorCode ?? "")
        : null;

  function failureText(failure: Failure): string {
    switch (failure.reason) {
      case "hourlyLimit":
        return t("errors.hourlyLimit", {
          limit: String(failure.limit),
          time: format.dateTime(new Date(failure.resetsAt), { timeStyle: "short" }),
        });
      case "signedOut":
        return t("errors.signedOut");
      case "notApproved":
      case "notFound":
      case "stale":
        return t(`errors.${failure.reason}`);
      default:
        return t("errors.generic");
    }
  }

  function start() {
    startSending(async () => {
      const result = await startExportAction({ assessmentId });
      if (result.ok || result.reason === "pending") {
        setRefusal(null);
        setJobId(result.jobId);
        focusStatus.current = true;
        return;
      }
      setRefusal(failureText(result));
      focusStatus.current = true;
    });
  }

  let statusText = "";
  if (refusal) statusText = refusal;
  else if (lost)
    statusText = t(lost === "signed-out" ? "errors.signedOut" : "errors.generic");
  else if (running) {
    statusText =
      job?.status === "running"
        ? t("status.running")
        : job?.status === "deferred"
          ? t("status.deferred")
          : job === null
            ? t("status.starting")
            : t("status.queued");
  } else if (failedCode !== null) {
    statusText = t(`errors.${ERROR_KEYS[failedCode] ?? "generic"}`);
  } else if (job?.status === "succeeded") statusText = t("status.done");

  const files = data.files;
  const hasFiles = files.length > 0 && !data.expired;
  const expiry = files.at(0)?.expiresAt;

  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-4 rounded-lg border bg-card p-5 shadow-card"
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="font-heading text-lg font-bold">
          {t("heading")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <p
        ref={statusRef}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className={
          statusText === ""
            ? "sr-only"
            : refusal || lost || failedCode !== null
              ? "flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive-soft p-3 text-sm font-medium text-destructive-foreground"
              : "text-sm font-medium"
        }
      >
        {statusText}
      </p>

      {hasFiles && !running && (
        <div className="flex flex-col gap-3">
          {expiry && (
            <p className="text-sm text-muted-foreground">
              {t("expiresOn", {
                date: format.dateTime(new Date(expiry), {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                }),
              })}
            </p>
          )}
          <ul aria-label={t("filesLabel")} className="flex flex-col gap-2">
            {DOCUMENTS.map((document) => {
              const links = files.filter((file) => file.document === document);
              if (links.length === 0) return null;
              const name = t(`documents.${document}`);
              return (
                <li
                  key={document}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
                >
                  <span className="min-w-0 font-semibold break-words">{name}</span>
                  <span className="flex flex-wrap gap-2">
                    {links.map((file) => (
                      <a
                        key={file.id}
                        href={`/api/exports/${file.id}`}
                        aria-label={
                          document === "zip"
                            ? t("downloadZip")
                            : t("downloadLabel", {
                                document: name,
                                format: t(`formats.${file.format}`),
                              })
                        }
                        className={document === "zip" ? primaryButton : secondaryButton}
                      >
                        <Download aria-hidden="true" className="size-4" />
                        {t(`formats.${file.format}`)}
                      </a>
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>
          <Warnings files={files} t={t} tWhere={tWhere} />
        </div>
      )}

      {data.expired && !running && (
        <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-warning-foreground">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t("expired")}
        </p>
      )}

      <div>
        <button
          type="button"
          onClick={start}
          disabled={sending || running}
          className={files.length > 0 ? secondaryButton : primaryButton}
        >
          {files.length > 0 ? (
            <RefreshCw aria-hidden="true" className="size-4" />
          ) : (
            <FileDown aria-hidden="true" className="size-4" />
          )}
          {files.length > 0 ? t("again") : t("start")}
        </button>
      </div>
    </section>
  );
}

/** What to check in the files: formulas written as text (per file), and an omitted logo (once). */
function Warnings({
  files,
  t,
  tWhere,
}: {
  files: ExportPanelFile[];
  t: Translate;
  tWhere: TranslateWhere;
}) {
  const has = (code: PanelWarning["code"]) =>
    files.some((file) => file.warnings.some((warning) => warning.code === code));
  const logo = has("logoOmitted");
  const logoMissing = has("logoMissing");
  const listOf = (code: "mathFailed" | "mathTooWide") =>
    files.flatMap((file) =>
      file.warnings.flatMap((warning: PanelWarning, index) =>
        warning.code === code
          ? [
              {
                key: `${file.id}-${String(index)}`,
                text: t("warningItem", {
                  file: `${t(`documents.${file.document}`)} (${t(`formats.${file.format}`)})`,
                  where: whereText(tWhere, warning.where),
                }),
              },
            ]
          : [],
      ),
    );
  const math = listOf("mathFailed");
  const tooWide = listOf("mathTooWide");
  if (math.length === 0 && tooWide.length === 0 && !logo && !logoMissing) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-warning-foreground">
      <p className="font-semibold">{t("warningsHeading")}</p>
      {logoMissing && <p>{t("logoMissing")}</p>}
      {logo && <p>{t("logoOmitted")}</p>}
      {math.length > 0 && (
        <>
          <p>{t("warningsHint")}</p>
          <ul className="list-disc pl-5">
            {math.map((entry) => (
              <li key={entry.key}>{entry.text}</li>
            ))}
          </ul>
        </>
      )}
      {tooWide.length > 0 && (
        <>
          <p>{t("tooWideHint")}</p>
          <ul className="list-disc pl-5">
            {tooWide.map((entry) => (
              <li key={entry.key}>{entry.text}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
