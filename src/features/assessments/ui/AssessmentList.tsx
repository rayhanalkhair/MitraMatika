import { useLocale, useTimeZone, useTranslations } from "next-intl";
import Link from "next/link";
import { CalendarDays, ClipboardList, Lock } from "lucide-react";
import { StatusPill } from "@/components/ui/status-pill";
import { TrashAssessmentButton } from "@/features/trash/ui/TrashAssessmentButton";
import { formatBankDate } from "@/lib/format-date";
import { DEFAULT_TIMEZONE } from "@/lib/timezone-shared";
import type { AssessmentListItem } from "../service/assessments";

/**
 * The teacher's assessments, most recently changed first, each a link to its editor with a
 * move-to-trash button beside the link (not inside it: a button may not sit in a link).
 */
export function AssessmentList({ items }: { items: AssessmentListItem[] }) {
  const t = useTranslations("assessments");
  const kinds = useTranslations("assessments.kinds");
  const view = { locale: useLocale(), timeZone: useTimeZone() ?? DEFAULT_TIMEZONE };

  if (items.length === 0) {
    return (
      <div className="flex min-w-0 flex-col items-center gap-3 rounded-lg border bg-card px-6 py-12 text-center shadow-card">
        <span
          aria-hidden="true"
          className="flex size-14 items-center justify-center rounded-lg bg-accent text-primary"
        >
          <ClipboardList className="size-7" />
        </span>
        <p className="font-heading text-lg font-bold">{t("list.empty")}</p>
        <p className="max-w-sm text-sm text-muted-foreground">{t("list.emptyHint")}</p>
      </div>
    );
  }
  return (
    <ul
      aria-label={t("list.listLabel")}
      className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2"
    >
      {items.map((item) => (
        <li key={item.id} className="relative min-w-0">
          <Link
            href={`/assessment-builder/${item.id}`}
            className="flex h-full min-h-11 min-w-0 flex-col gap-3 rounded-lg border bg-card p-4 shadow-card transition-colors duration-150 hover:border-primary/40 hover:bg-accent/30"
          >
            <span className="flex flex-wrap items-start justify-between gap-2">
              <span className="min-w-0 font-heading font-semibold break-words">
                {item.title}
              </span>
              <StatusPill tone={item.status === "approved" ? "success" : "neutral"}>
                {item.status === "approved" && (
                  <Lock aria-hidden="true" className="size-4" />
                )}
                {t(`list.status.${item.status}`)}
              </StatusPill>
            </span>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span>{kinds(item.kind)}</span>
              <span>{t("form.gradeOption", { grade: item.grade })}</span>
              <span>{t("list.itemCount", { count: item.itemCount })}</span>
              <span>{t("list.sectionCount", { count: item.sectionCount })}</span>
            </span>
            <span className="inline-flex items-center gap-1 pe-12 text-sm text-muted-foreground">
              <CalendarDays aria-hidden="true" className="size-4" />
              {t("list.updated", { date: formatBankDate(item.updatedAt, view) })}
            </span>
          </Link>
          <span className="absolute end-2 bottom-2">
            <TrashAssessmentButton assessmentId={item.id} title={item.title} compact />
          </span>
        </li>
      ))}
    </ul>
  );
}
