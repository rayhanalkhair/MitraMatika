import { useLocale, useTimeZone, useTranslations } from "next-intl";
import Link from "next/link";
import { Archive, CalendarDays, ChevronRight, Plus, SearchX } from "lucide-react";
import { MathText } from "@/components/math/MathText";
import { CurriculumChip } from "@/components/curriculum/CurriculumChip";
import { VerificationBadge } from "@/features/review/ui/VerificationBadge";
import { formatBankDate } from "@/lib/format-date";
import { DEFAULT_TIMEZONE } from "@/lib/timezone-shared";
import type { BankListItem } from "@/features/bank/service/bank";
import { TrashQuestionButton } from "@/features/trash/ui/TrashQuestionButton";

const LINK_CLASS =
  "inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors duration-150 hover:bg-primary-hover";

// `bankTotal` is the real size of the whole bank (not the page or the filtered count). The verified
// tile is shown only when the list holds every banked question, so it never reports a number taken
// from one page or one filter. No items with a non-empty bank means the filters match nothing.
export function BankList({
  items,
  bankTotal,
  resetHref,
}: {
  items: BankListItem[];
  bankTotal: number;
  resetHref?: string;
}) {
  const t = useTranslations();
  const view = { locale: useLocale(), timeZone: useTimeZone() ?? DEFAULT_TIMEZONE };
  if (items.length === 0 && bankTotal === 0) {
    return (
      <div className="flex min-w-0 flex-col items-center gap-3 rounded-lg border bg-card px-6 py-12 text-center shadow-card">
        <span
          aria-hidden="true"
          className="flex size-14 items-center justify-center rounded-lg bg-accent text-primary"
        >
          <Archive className="size-7" />
        </span>
        <p className="font-heading text-lg font-bold">{t("bank.empty")}</p>
        <p className="max-w-sm text-sm text-muted-foreground">{t("bank.emptyHint")}</p>
        <Link href="/generate" className={LINK_CLASS}>
          <Plus aria-hidden="true" className="size-4" />
          {t("bank.emptyAction")}
        </Link>
      </div>
    );
  }
  const verified =
    items.length === bankTotal
      ? items.filter((item) => item.status === "terverifikasi").length
      : null;
  const tiles = [
    { key: "total" as const, value: bankTotal },
    ...(verified === null ? [] : [{ key: "verified" as const, value: verified }]),
  ];
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div
        role="group"
        aria-label={t("bank.summaryLabel")}
        className="grid grid-cols-2 gap-3 sm:max-w-md"
      >
        {tiles.map((tile) => (
          <div
            key={tile.key}
            className="rounded-lg border bg-card p-4 shadow-card"
            data-tile={tile.key}
          >
            <p className="text-sm text-muted-foreground">
              {tile.key === "total" ? t("bank.total") : t("bank.verified")}
            </p>
            <p className="font-heading text-2xl font-bold">{tile.value}</p>
          </div>
        ))}
      </div>
      {items.length === 0 ? (
        <div className="flex min-w-0 flex-col items-center gap-3 rounded-lg border bg-card px-6 py-12 text-center shadow-card">
          <span
            aria-hidden="true"
            className="flex size-14 items-center justify-center rounded-lg bg-accent text-primary"
          >
            <SearchX className="size-7" />
          </span>
          <p className="font-heading text-lg font-bold">{t("bank.noMatch")}</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            {t("bank.noMatchHint")}
          </p>
          {resetHref && (
            <Link href={resetHref} className={LINK_CLASS}>
              {t("bank.noMatchAction")}
            </Link>
          )}
        </div>
      ) : (
        <ul className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2">
          {items.map((item) => (
            <li key={item.questionId} className="relative min-w-0">
              <Link
                href={`/question-bank/${item.questionId}`}
                className="flex h-full min-h-11 min-w-0 flex-col gap-3 rounded-lg border bg-card p-4 pr-14 shadow-card transition-colors duration-150 hover:border-primary/40 hover:bg-accent/30"
              >
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="min-w-0 font-heading font-semibold break-words">
                    {item.topicTitle}
                  </span>
                  {item.objectiveCode && <CurriculumChip code={item.objectiveCode} />}
                </span>
                <MathText
                  text={item.stemExcerptMd}
                  className="block min-w-0 overflow-x-auto text-sm break-words"
                />
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                  <span>{t(`review.difficulty.${item.difficulty}`)}</span>
                  <span>{t("bank.type")}</span>
                  <span className="inline-flex items-center gap-1">
                    <CalendarDays aria-hidden="true" className="size-4" />
                    {t("bank.savedOn", { date: formatBankDate(item.bankedAt, view) })}
                  </span>
                </span>
                <span className="mt-auto flex items-center justify-between gap-2">
                  <VerificationBadge status={item.status} />
                  <ChevronRight
                    aria-hidden="true"
                    className="size-5 shrink-0 text-muted-foreground"
                  />
                </span>
              </Link>
              {/* The card's menu: outside the link, so it is its own control. */}
              <span className="absolute top-2 right-2">
                <TrashQuestionButton
                  questionId={item.questionId}
                  topic={item.topicTitle}
                  compact
                />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
