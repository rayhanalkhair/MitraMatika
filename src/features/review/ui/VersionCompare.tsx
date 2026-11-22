// A client component through its only importer, RegenerateControl.
import { useId } from "react";
import { useTranslations } from "next-intl";
import { CircleCheck, Undo2 } from "lucide-react";
import { MathText } from "@/components/math/MathText";
import type { ReviewQuestion } from "../service/review";

const BUTTON =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60";

export function VersionColumn({
  label,
  version,
  tone,
}: {
  label: string;
  version: ReviewQuestion;
  tone: "old" | "new";
}) {
  const t = useTranslations("review");
  const labelId = useId();
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className={`flex min-w-0 flex-col gap-3 rounded-lg border p-3 ${
        tone === "new" ? "border-primary/40 bg-card" : "bg-muted"
      }`}
    >
      <p id={labelId} className="text-sm font-semibold text-muted-foreground">
        {label}
      </p>
      <MathText text={version.stemMd} className="block min-w-0 break-words" />
      <ol aria-label={t("optionsLabel")} className="flex flex-col gap-1.5 text-sm">
        {version.options.map((option) => {
          const isKey = option.label === version.correctLabel;
          return (
            <li
              key={option.label}
              className={`flex min-w-0 gap-2 rounded-md border px-2 py-1.5 ${
                isKey ? "border-success bg-success-soft" : "bg-background"
              }`}
            >
              <span className="font-semibold text-primary">{option.label}.</span>
              <MathText text={option.textMd} className="min-w-0 break-words" />
              {isKey && (
                <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-success-foreground">
                  <CircleCheck aria-hidden="true" className="size-4" />
                  <span className="sr-only">{t("keyLabel")}</span>
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <p className="text-sm">
        <span className="font-medium text-muted-foreground">{t("answerLabel")}: </span>
        <MathText text={version.answerDisplayMd} />
      </p>
    </div>
  );
}

/**
 * The version before a regeneration next to the new one. Keeping the new version is the default
 * (first action, and nothing changes without a click); restoring copies the old one into a new
 * version.
 */
export function VersionCompare({
  previous,
  current,
  onKeep,
  onRestore,
  restoring,
  headingLevel = 4,
}: {
  // One level under the card the comparison sits in (a review card is an h3, the bank detail's an h2).
  headingLevel?: 3 | 4;
  previous: ReviewQuestion;
  current: ReviewQuestion;
  onKeep: () => void;
  onRestore: () => void;
  restoring: boolean;
}) {
  const t = useTranslations("review.regenerate.compare");
  const headingId = useId();
  const Heading = headingLevel === 3 ? "h3" : "h4";
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-primary/30 bg-accent/40 p-3 sm:p-4"
    >
      <Heading id={headingId} className="font-heading text-base font-semibold">
        {t("heading")}
      </Heading>
      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        <VersionColumn
          label={t("previous", { number: String(previous.versionNo) })}
          version={previous}
          tone="old"
        />
        <VersionColumn
          label={t("new", { number: String(current.versionNo) })}
          version={current}
          tone="new"
        />
      </div>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onKeep}
          disabled={restoring}
          className={`${BUTTON} bg-primary text-primary-foreground hover:bg-primary-hover`}
        >
          {t("keep")}
        </button>
        <button
          type="button"
          onClick={onRestore}
          disabled={restoring}
          className={`${BUTTON} border border-input bg-card text-foreground hover:bg-secondary`}
        >
          <Undo2 aria-hidden="true" className="size-4" />
          {restoring ? t("restoring") : t("restore")}
        </button>
      </div>
    </section>
  );
}
