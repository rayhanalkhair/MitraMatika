// Rendered only by UploadDropzone, whose "use client" boundary it shares; not an entry file, so
// its callback props never cross from the server.
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { cancelUploadAction } from "../actions/cancel-upload";
import { startUploadAction } from "../actions/start-upload";
import { titleFromFileName, type UploadErrorKey } from "../schema/upload";
import { requestFinalize } from "./finalize-request";
import { putFile } from "./put-file";

type Phase =
  | { step: "uploading"; percent: number }
  | { step: "checking" }
  | { step: "done"; materialId: string }
  | { step: "failed"; error: UploadErrorKey };

interface Signed {
  uploadUrl: string;
  objectKey: string;
  contentType: string;
}

// Where a retry starts again. "put": the reservation still holds and its URL may still be valid
// (the file did not arrive). "finalize": the file is there, only finalise failed for a reason
// that keeps the reservation. "start": a new reservation is needed.
type Resume = "start" | "put" | "finalize";
/** Automatic retries of a `busy` finalise, about 20 s in all, before the retry button shows. */
const BUSY_RETRY_DELAYS_MS = [2_000, 6_000, 12_000];
const KEEPS_FILE: ReadonlySet<UploadErrorKey> = new Set(["title", "folder", "busy"]);

const errorClass =
  "rounded-lg border border-destructive/30 bg-destructive-soft p-3 text-sm font-medium text-destructive-foreground";
const buttonClass =
  "inline-flex min-h-11 items-center justify-center rounded-lg border border-border bg-card px-4 font-heading text-sm font-semibold text-primary transition-colors duration-150 hover:bg-accent";

/**
 * One file's upload: asks for a signed URL, PUTs the file there with progress, then finalises
 * through the finalise route (the server checks what arrived, R16). The polite live region announces each phase and the progress
 * in steps of 10% (the progress bar carries the exact value); a refusal is an alert with its typed
 * reason. Cancel aborts the transfer and cancels the reservation (it counts toward the caps until
 * its URL expires); leaving the page aborts too.
 * Retry reuses the reservation whenever it still holds.
 */
export function UploadProgress({
  file,
  folderId,
  onDismiss,
  onFinalized,
}: {
  file: File;
  folderId?: string;
  onDismiss: () => void;
  /** A material was created (the page shows it). */
  onFinalized?: () => void;
}) {
  const t = useTranslations("materials.upload");
  const [phase, setPhase] = useState<Phase>({ step: "uploading", percent: 0 });
  const signed = useRef<Signed | null>(null);
  const resume = useRef<Resume>("start");
  const controller = useRef<AbortController | null>(null);
  // The reservation being asked for. React's development StrictMode runs the effect twice (mount,
  // clean up, mount): both runs share this one request instead of reserving twice.
  const starting = useRef<ReturnType<typeof startUploadAction> | null>(null);

  const finalize = useCallback(
    async (target: Signed) => {
      setPhase({ step: "checking" });
      const request = () =>
        requestFinalize({
          objectKey: target.objectKey,
          title: titleFromFileName(file.name) || file.name,
          ...(folderId ? { folderId } : {}),
        });
      let result = await request();
      // The server was reading another file (R29/R31): try again by itself a few times before
      // asking the teacher. The upload is kept meanwhile.
      for (const delay of BUSY_RETRY_DELAYS_MS) {
        if (result.ok || result.error !== "busy") break;
        await new Promise((resolve) => setTimeout(resolve, delay));
        result = await request();
      }
      if (result.ok) {
        setPhase({ step: "done", materialId: result.materialId });
        onFinalized?.();
        return;
      }
      resume.current =
        result.error === "missing"
          ? "put"
          : KEEPS_FILE.has(result.error)
            ? "finalize"
            : "start";
      setPhase({ step: "failed", error: result.error });
    },
    [file, folderId, onFinalized],
  );

  const run = useCallback(async () => {
    const abort = new AbortController();
    controller.current = abort;
    try {
      let target = signed.current;
      if (resume.current === "start" || target === null) {
        setPhase({ step: "uploading", percent: 0 });
        const pending = (starting.current ??= startUploadAction({
          fileName: file.name,
          declaredType: file.type,
          size: file.size,
        }));
        let answer: Awaited<typeof pending>;
        try {
          answer = await pending;
        } finally {
          if (starting.current === pending) starting.current = null;
        }
        // Left or cancelled while the URL was being signed; a run started since carries on.
        if (abort.signal.aborted) return;
        if (!answer.ok) {
          setPhase({ step: "failed", error: answer.error });
          return;
        }
        target = {
          uploadUrl: answer.uploadUrl,
          objectKey: answer.objectKey,
          contentType: answer.contentType,
        };
        signed.current = target;
        resume.current = "put";
      }
      if (resume.current === "put") {
        setPhase({ step: "uploading", percent: 0 });
        const sent = await putFile(
          target.uploadUrl,
          file,
          target.contentType,
          (percent) => {
            setPhase({ step: "uploading", percent });
          },
          abort.signal,
        );
        if (abort.signal.aborted) return;
        if (!sent) {
          // The URL lasts 5 minutes; after a failed transfer start over with a fresh one.
          resume.current = "start";
          setPhase({ step: "failed", error: "network" });
          return;
        }
        resume.current = "finalize";
      }
      await finalize(target);
    } catch {
      resume.current = "start";
      setPhase({ step: "failed", error: "network" });
    }
  }, [file, finalize]);

  // The parent passes fresh callbacks on every render, which changes `run`; the upload must not
  // restart (or be aborted) because of that, so the mount effect below reads the latest run.
  const latestRun = useRef(run);
  useEffect(() => {
    latestRun.current = run;
  }, [run]);

  useEffect(() => {
    // Every mount starts a run. Under StrictMode's double effects the first run is aborted by the
    // clean-up and the second one takes over (they share the one signed URL request above); a
    // guard that skipped the second mount left the aborted first run, and no upload, behind.
    void latestRun.current();
    return () => {
      controller.current?.abort();
    };
  }, []);

  async function cancel() {
    controller.current?.abort();
    const target = signed.current;
    if (target) await cancelUploadAction({ objectKey: target.objectKey });
    onDismiss();
  }

  const name = file.name;
  const percent =
    phase.step === "uploading" ? phase.percent : phase.step === "failed" ? 0 : 100;
  // Screen readers hear every 10%, not every percent.
  const announced = Math.floor(percent / 10) * 10;
  const status =
    phase.step === "uploading"
      ? t("uploading", { name, percent: announced })
      : phase.step === "checking"
        ? t("checking", { name })
        : phase.step === "done"
          ? t("done", { name })
          : t("failed", { name });

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <p role="status" aria-live="polite" className="text-sm font-medium">
        {status}
      </p>
      <div
        role="progressbar"
        aria-label={t("progressLabel", { name })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-150"
          style={{ width: `${String(percent)}%` }}
        />
      </div>
      {phase.step === "uploading" ? (
        <button
          type="button"
          onClick={() => {
            void cancel();
          }}
          className={`${buttonClass} self-start`}
        >
          {t("cancel")}
        </button>
      ) : null}
      {phase.step === "failed" ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className={errorClass}>
            {t(`errors.${phase.error}`)}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                void run();
              }}
              className={buttonClass}
            >
              {t("retry")}
            </button>
            <button
              type="button"
              onClick={() => {
                void cancel();
              }}
              className={buttonClass}
            >
              {t("dismiss")}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
