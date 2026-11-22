"use client";

import { useId, useState, type SubmitEvent } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { ImageOff, Sparkles, TriangleAlert } from "lucide-react";
import { MathText } from "@/components/math/MathText";
import {
  card,
  control,
  noticeClass,
  primaryButton,
} from "@/features/materials/ui/styles";
import { cn } from "@/lib/utils";
import { confirmExtractionAction } from "../actions/solver";
import { MAX_PROBLEM_CHARS } from "../schema/solver";
import type { ExtractionIssue } from "../service/issues";
import { useSolverErrorText } from "./error-text";

type Notice = { kind: "status" | "alert"; text: string } | null;

/**
 * SOL-02: the vision model's reading of a photo, beside the photo, when any part of it is
 * uncertain (or when the photo could not be read at all). The teacher corrects the text (KaTeX
 * preview, the uncertain parts listed) and confirms; only then is the problem solved. The server
 * refuses a text that still holds a `[[?]]` marker.
 */
export function ExtractionConfirm({
  sessionId,
  extractedMd,
  issues,
  hasPhoto,
  readingFailed,
}: {
  sessionId: string;
  extractedMd: string | null;
  issues: ExtractionIssue[];
  hasPhoto: boolean;
  readingFailed: boolean;
}) {
  const t = useTranslations("solve.confirm");
  const errorText = useSolverErrorText();
  const router = useRouter();
  const id = useId();
  const [text, setText] = useState(extractedMd ?? "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  async function confirm(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice({ kind: "status", text: t("working") });
    try {
      const result = await confirmExtractionAction({ sessionId, text });
      if (!result.ok) {
        setNotice({ kind: "alert", text: errorText(result.error) });
        return;
      }
      setNotice({ kind: "status", text: t("confirmed") });
      router.refresh();
    } catch {
      setNotice({ kind: "alert", text: errorText("generic") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`${id}-heading`} className={card}>
      <h2 id={`${id}-heading`} className="font-heading text-lg font-bold">
        {t("heading")}
      </h2>
      <p className="text-sm text-muted-foreground">
        {readingFailed ? t("failedDescription") : t("description")}
      </p>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <div className="min-w-0">
          {hasPhoto ? (
            // eslint-disable-next-line @next/next/no-img-element -- an owner-checked, uncached route
            <img
              src={`/api/solve/${sessionId}/photo`}
              alt={t("photoAlt")}
              className="max-h-96 w-full rounded-lg border object-contain"
            />
          ) : (
            <p className="flex items-center gap-2 rounded-lg border bg-muted p-3 text-sm text-muted-foreground">
              <ImageOff aria-hidden="true" className="size-4 shrink-0" />
              {t("photoGone")}
            </p>
          )}
        </div>
        <form
          onSubmit={(event) => void confirm(event)}
          className="flex min-w-0 flex-col gap-3"
        >
          {issues.length > 0 && (
            <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-warning-foreground">
              <p className="flex items-center gap-2 font-semibold">
                <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
                {t("issuesHeading")}
              </p>
              <ul className="list-disc ps-5">
                {issues.map((issue, index) => (
                  <li key={index} className="break-words">
                    {issue.kind === "uncertain"
                      ? t("issueUncertain", { text: issue.text })
                      : issue.kind === "katex"
                        ? t("issueKatex", { text: issue.text })
                        : issue.kind === "truncated"
                          ? t("issueTruncated")
                          : t("issueEmpty")}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <label htmlFor={`${id}-text`} className="text-sm font-semibold">
            {t("textLabel")}
          </label>
          <textarea
            id={`${id}-text`}
            value={text}
            maxLength={MAX_PROBLEM_CHARS}
            rows={8}
            aria-describedby={`${id}-hint`}
            onChange={(event) => {
              setText(event.target.value);
            }}
            className={cn(control, "min-h-40 py-2 leading-relaxed")}
          />
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            {t("hint")}
          </p>
          <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-dashed bg-muted/50 p-3">
            <p className="text-xs font-semibold tracking-wide text-primary uppercase">
              {t("preview")}
            </p>
            <MathText text={text} className="block min-w-0 text-sm" />
          </div>
          <button
            type="submit"
            disabled={busy}
            aria-busy={busy}
            className={primaryButton}
          >
            <Sparkles aria-hidden="true" className="size-4" />
            {t("submit")}
          </button>
          <p
            role={notice?.kind === "alert" ? "alert" : "status"}
            className={notice ? noticeClass(notice.kind) : "sr-only"}
          >
            {notice?.text}
          </p>
        </form>
      </div>
    </section>
  );
}
