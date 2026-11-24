"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useLocale, useTimeZone, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Undo2 } from "lucide-react";
import { restoreVersionAction } from "@/features/bank/actions/restore-version";
import { VerificationBadge } from "@/features/review/ui/VerificationBadge";
import { VersionColumn } from "@/features/review/ui/VersionCompare";
import type { ReviewQuestion } from "@/features/review";
import { formatBankDate } from "@/lib/format-date";
import { DEFAULT_TIMEZONE } from "@/lib/timezone-shared";
import { cn } from "@/lib/utils";
import type { VersionSummary } from "../service/versions";

const KINDS = ["generated", "regenerated", "edited", "restored"] as const;
const AUTHORS = ["ai", "teacher"] as const;
const REASONS = {
  stale: "stale",
  not_ready: "notReady",
  current: "current",
  trashed: "trashed",
  not_found: "notFound",
  signed_out: "signedOut",
  generic: "generic",
} as const;

const pick = <T extends string>(options: readonly T[], value: string): T | null =>
  options.find((option) => option === value) ?? null;

/**
 * Every version of a question, newest first; any of them opens read-only (the page passes the
 * chosen one) and can be restored as a new version. The restore quotes the question's row version,
 * so a change made elsewhere is refused with a message, never overwritten. The page keys it by the
 * chosen version, so opening another one starts without the previous message.
 */
export function VersionHistory({
  questionId,
  rowVersion,
  versions,
  historyPath,
  selected,
  selectedId,
}: {
  questionId: string;
  rowVersion: number;
  versions: VersionSummary[];
  historyPath: string;
  selected: ReviewQuestion | null;
  selectedId?: string;
}) {
  const t = useTranslations("bank.history");
  const view = { locale: useLocale(), timeZone: useTimeZone() ?? DEFAULT_TIMEZONE };
  const router = useRouter();
  const [restoring, startRestoring] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);
  const focusStatus = useRef(false);

  // After a restore the button is gone or stale: focus moves to the confirmation.
  useEffect(() => {
    if (notice && focusStatus.current) {
      focusStatus.current = false;
      statusRef.current?.focus();
    }
  }, [notice]);

  const current = versions.find((version) => version.isCurrent);
  const isCurrent = selectedId !== undefined && selectedId === current?.id;

  function restore() {
    if (!selectedId) return;
    startRestoring(async () => {
      const result = await restoreVersionAction({
        questionId,
        versionId: selectedId,
        expectedRowVersion: rowVersion,
      });
      if (result.ok) {
        setError(null);
        focusStatus.current = true;
        setRestored(true);
        setNotice(t("restored"));
        router.refresh();
        return;
      }
      setNotice(null);
      setError(t(`errors.${REASONS[result.reason]}`));
    });
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <ol aria-label={t("listLabel")} className="flex flex-col gap-2">
        {versions.map((version) => {
          const kind = pick(KINDS, version.changeKind);
          const author = pick(AUTHORS, version.author);
          const open = version.id === selectedId;
          return (
            <li key={version.id}>
              <Link
                href={`${historyPath}?version=${version.id}`}
                aria-current={open ? "true" : undefined}
                className={cn(
                  "flex min-h-11 min-w-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-card p-3 transition-colors duration-150 hover:bg-secondary",
                  open && "border-primary bg-accent/40",
                )}
              >
                <span className="font-heading font-semibold">
                  {t("versionNumber", { number: String(version.versionNo) })}
                </span>
                {version.isCurrent && (
                  <span className="text-sm font-medium text-primary">{t("current")}</span>
                )}
                <span className="text-sm text-muted-foreground">
                  {kind ? t(`kinds.${kind}`) : version.changeKind}
                  {" · "}
                  {author ? t(`authors.${author}`) : version.author}
                  {" · "}
                  <time dateTime={version.createdAt}>
                    {formatBankDate(version.createdAt, view)}
                  </time>
                </span>
                <span className="ml-auto">
                  <VerificationBadge status={version.status} />
                </span>
              </Link>
            </li>
          );
        })}
      </ol>

      <div
        ref={statusRef}
        role="status"
        tabIndex={-1}
        className="text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {notice && (
          <p className="rounded-lg border bg-card p-3 text-muted-foreground">{notice}</p>
        )}
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-warning-foreground"
        >
          {error}
        </p>
      )}

      {selected ? (
        <section
          aria-label={t("viewLabel")}
          className="flex min-w-0 flex-col gap-3 rounded-lg border p-3 sm:p-4"
        >
          <p className="text-sm text-muted-foreground">{t("readOnly")}</p>
          <VersionColumn
            label={t("versionNumber", { number: String(selected.versionNo) })}
            version={selected}
            tone="new"
          />
          {restored && current ? (
            <Link
              href={`${historyPath}?version=${current.id}`}
              className="inline-flex min-h-11 items-center text-sm font-semibold text-primary hover:underline"
            >
              {t("viewCurrent")}
            </Link>
          ) : isCurrent ? (
            <p className="text-sm font-medium">{t("isCurrent")}</p>
          ) : (
            <div>
              <button
                type="button"
                onClick={restore}
                disabled={restoring}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors duration-150 hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Undo2 aria-hidden="true" className="size-4" />
                {restoring ? t("restoring") : t("restore")}
              </button>
            </div>
          )}
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">{t("openHint")}</p>
      )}
    </div>
  );
}
