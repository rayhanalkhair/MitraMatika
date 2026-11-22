"use client";

import { useId, useRef, useState, type SubmitEvent } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Camera, ImageUp, Keyboard, Sparkles } from "lucide-react";
import { MathText } from "@/components/math/MathText";
import { putFile } from "@/features/materials/ui/put-file";
import {
  card,
  control,
  noticeClass,
  primaryButton,
  secondaryButton,
} from "@/features/materials/ui/styles";
import { cn } from "@/lib/utils";
import {
  finalizePhotoAction,
  solveTextAction,
  startPhotoAction,
} from "../actions/solver";
import {
  MAX_PROBLEM_CHARS,
  SOLVER_PHOTO_ACCEPT,
  USER_DAILY_SOLVES,
  type SolverPhotoMime,
} from "../schema/solver";
import { USER_DAILY_VISION_READS } from "@/features/materials/ui/vision-cap";
import { useSolverErrorText } from "./error-text";
import { shrinkPhoto } from "./shrink-photo";

type Tab = "text" | "photo";
type Notice = { kind: "status" | "alert"; text: string } | null;

const isPhotoMime = (type: string): type is SolverPhotoMime =>
  type === "image/png" || type === "image/jpeg";

/**
 * The problem, typed (with a KaTeX preview) or as a photo (camera or gallery). A typed problem is
 * solved at once; a photo goes straight to storage with a signed PUT and is then read by the
 * vision model. Both take the teacher to the session page.
 */
export function SolverInput({
  solvesLeft,
  visionLeft,
}: {
  solvesLeft: number;
  /** Vision reads left today, OCR pages and photo reads together (R28). */
  visionLeft: number;
}) {
  const t = useTranslations("solve.input");
  const tSolve = useTranslations("solve");
  const errorText = useSolverErrorText();
  const router = useRouter();
  const id = useId();
  const [tab, setTab] = useState<Tab>("text");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [photo, setPhoto] = useState<{ file: File; kind: "photo" | "file" } | null>(null);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({
    text: null,
    photo: null,
  });
  const noneLeft = solvesLeft <= 0;
  const noVisionLeft = visionLeft <= 0;

  function choose(next: Tab, focus = false) {
    setTab(next);
    setNotice(null);
    if (focus) tabRefs.current[next]?.focus();
  }

  async function solveText(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (text.trim() === "") {
      setNotice({ kind: "alert", text: errorText("empty") });
      return;
    }
    setBusy(true);
    setNotice({ kind: "status", text: t("sending") });
    try {
      const result = await solveTextAction({ text });
      if (!result.ok) {
        setNotice({ kind: "alert", text: errorText(result.error) });
        return;
      }
      router.push(`/solve/${result.sessionId}`);
    } catch {
      setNotice({ kind: "alert", text: errorText("generic") });
    } finally {
      setBusy(false);
    }
  }

  function pick(kind: "photo" | "file", files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    if (!isPhotoMime(file.type)) {
      setPhoto(null);
      setNotice({ kind: "alert", text: errorText("type") });
      return;
    }
    setNotice(null);
    setPhoto({ file, kind });
  }

  async function sendPhoto() {
    if (!photo) return;
    setBusy(true);
    setNotice({ kind: "status", text: t("preparing") });
    try {
      const file = await shrinkPhoto(photo.file);
      if (!file || !isPhotoMime(file.type)) {
        setNotice({ kind: "alert", text: errorText("size") });
        return;
      }
      const started = await startPhotoAction({
        kind: photo.kind,
        mime: file.type,
        size: file.size,
      });
      if (!started.ok) {
        setNotice({ kind: "alert", text: errorText(started.error) });
        return;
      }
      let shown = -1;
      const sent = await putFile(started.uploadUrl, file, file.type, (percent) => {
        // Announce in steps of 10 %, not every progress event.
        const step = Math.floor(percent / 10) * 10;
        if (step !== shown) {
          shown = step;
          setNotice({ kind: "status", text: t("uploading", { percent: step }) });
        }
      });
      if (!sent) {
        setNotice({ kind: "alert", text: errorText("upload") });
        return;
      }
      setNotice({ kind: "status", text: t("checking") });
      const finalized = await finalizePhotoAction({ sessionId: started.sessionId });
      if (!finalized.ok) {
        setNotice({ kind: "alert", text: errorText(finalized.error) });
        return;
      }
      router.push(`/solve/${started.sessionId}`);
    } catch {
      setNotice({ kind: "alert", text: errorText("generic") });
    } finally {
      setBusy(false);
    }
  }

  const tabClass = (active: boolean) =>
    cn(
      "inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md px-3 text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
      active
        ? "bg-card text-primary shadow-card"
        : "text-muted-foreground hover:text-foreground",
    );

  return (
    <section aria-labelledby={`${id}-heading`} className={card}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`${id}-heading`} className="font-heading text-lg font-bold">
          {t("heading")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {tSolve("left", { left: solvesLeft, limit: USER_DAILY_SOLVES })}
        </p>
      </div>
      <div
        role="tablist"
        aria-label={t("tabsLabel")}
        className="flex gap-1 rounded-lg bg-muted p-1"
      >
        {(["text", "photo"] as const).map((value) => (
          <button
            key={value}
            ref={(element) => {
              tabRefs.current[value] = element;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${value}`}
            aria-selected={tab === value}
            aria-controls={`${id}-panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => {
              choose(value);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                event.preventDefault();
                choose(value === "text" ? "photo" : "text", true);
              }
            }}
            className={tabClass(tab === value)}
          >
            {value === "text" ? (
              <Keyboard aria-hidden="true" className="size-4" />
            ) : (
              <Camera aria-hidden="true" className="size-4" />
            )}
            {value === "text" ? t("typeTab") : t("photoTab")}
          </button>
        ))}
      </div>

      {tab === "text" ? (
        <form
          id={`${id}-panel-text`}
          role="tabpanel"
          aria-labelledby={`${id}-tab-text`}
          onSubmit={(event) => void solveText(event)}
          className="flex min-w-0 flex-col gap-3"
        >
          <label htmlFor={`${id}-text`} className="text-sm font-semibold">
            {t("textLabel")}
          </label>
          <textarea
            id={`${id}-text`}
            value={text}
            maxLength={MAX_PROBLEM_CHARS}
            rows={6}
            aria-describedby={`${id}-hint ${id}-count`}
            onChange={(event) => {
              setText(event.target.value);
            }}
            className={cn(control, "min-h-36 py-2 leading-relaxed")}
          />
          <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
            <p id={`${id}-hint`}>{t("textHint")}</p>
            <p id={`${id}-count`}>
              {t("count", { count: text.length, max: MAX_PROBLEM_CHARS })}
            </p>
          </div>
          <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-dashed bg-muted/50 p-3">
            <p className="text-xs font-semibold tracking-wide text-primary uppercase">
              {t("preview")}
            </p>
            {text.trim() === "" ? (
              <p className="text-sm text-muted-foreground">{t("previewEmpty")}</p>
            ) : (
              <MathText text={text} className="block min-w-0 text-sm" />
            )}
          </div>
          <button
            type="submit"
            disabled={busy || noneLeft}
            aria-busy={busy}
            className={primaryButton}
          >
            <Sparkles aria-hidden="true" className="size-4" />
            {t("submit")}
          </button>
        </form>
      ) : (
        <div
          id={`${id}-panel-photo`}
          role="tabpanel"
          aria-labelledby={`${id}-tab-photo`}
          className="flex min-w-0 flex-col gap-3"
        >
          <p className="text-sm text-muted-foreground">{t("photoHint")}</p>
          <p className="text-sm font-semibold">
            {t("visionLeft", { left: visionLeft, cap: USER_DAILY_VISION_READS })}
          </p>
          {noVisionLeft && !noneLeft && (
            <p className={noticeClass("alert")}>{errorText("visionLimit")}</p>
          )}
          <p className="text-sm font-medium">{t("privacy")}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <label
              className={cn(
                secondaryButton,
                "cursor-pointer focus-within:ring-2 focus-within:ring-ring",
              )}
            >
              <Camera aria-hidden="true" className="size-4" />
              {t("camera")}
              <input
                type="file"
                accept={SOLVER_PHOTO_ACCEPT}
                capture="environment"
                className="sr-only"
                disabled={busy}
                onChange={(event) => {
                  pick("photo", event.target.files);
                }}
              />
            </label>
            <label
              className={cn(
                secondaryButton,
                "cursor-pointer focus-within:ring-2 focus-within:ring-ring",
              )}
            >
              <ImageUp aria-hidden="true" className="size-4" />
              {t("gallery")}
              <input
                type="file"
                accept={SOLVER_PHOTO_ACCEPT}
                className="sr-only"
                disabled={busy}
                onChange={(event) => {
                  pick("file", event.target.files);
                }}
              />
            </label>
          </div>
          {photo && (
            <p className="text-sm break-words">
              {t("chosen", { name: photo.file.name })}
            </p>
          )}
          <button
            type="button"
            disabled={busy || photo === null || noneLeft || noVisionLeft}
            aria-busy={busy}
            onClick={() => void sendPhoto()}
            className={primaryButton}
          >
            <Sparkles aria-hidden="true" className="size-4" />
            {t("sendPhoto")}
          </button>
        </div>
      )}

      {noneLeft && <p className={noticeClass("alert")}>{errorText("limit")}</p>}
      <p
        role={notice?.kind === "alert" ? "alert" : "status"}
        className={notice ? noticeClass(notice.kind) : "sr-only"}
      >
        {notice?.text}
      </p>
    </section>
  );
}
