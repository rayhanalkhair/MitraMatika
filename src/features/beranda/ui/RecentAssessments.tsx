import { useLocale, useTimeZone, useTranslations } from "next-intl";
import Link from "next/link";
import { ArrowRight, ClipboardList, Lock } from "lucide-react";
import { StatusPill } from "@/components/ui/status-pill";
import { formatBankDate } from "@/lib/format-date";
import { DEFAULT_TIMEZONE } from "@/lib/timezone-shared";
import type { RecentAssessment } from "@/features/beranda/service/recent-assessments";

/** The three most recently changed assessments, each a link to its editor, then a link to all. */
export function RecentAssessments({ items }: { items: RecentAssessment[] }) {
  const t = useTranslations("beranda.recent");
  const list = useTranslations("assessments.list");
  const view = { locale: useLocale(), timeZone: useTimeZone() ?? DEFAULT_TIMEZONE };
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {items.length === 0 ? (
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <ClipboardList aria-hidden="true" className="size-5 shrink-0" />
          <p>{t("empty")}</p>
        </div>
      ) : (
        <ul className="flex min-w-0 flex-col gap-3">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                href={`/assessment-builder/${item.id}`}
                className="flex min-h-11 min-w-0 flex-col gap-1 rounded-lg border bg-card p-4 transition-colors duration-150 hover:bg-accent/40"
              >
                <span className="flex flex-wrap items-start justify-between gap-2">
                  <span className="min-w-0 font-heading font-semibold break-words">
                    {item.title}
                  </span>
                  <StatusPill tone={item.status === "approved" ? "success" : "neutral"}>
                    {item.status === "approved" && (
                      <Lock aria-hidden="true" className="size-4" />
                    )}
                    {list(`status.${item.status}`)}
                  </StatusPill>
                </span>
                <span className="text-sm text-muted-foreground">
                  {list("updated", { date: formatBankDate(item.updatedAt, view) })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link
        href="/assessment-builder"
        className="inline-flex min-h-11 items-center gap-2 self-start rounded-lg text-sm font-semibold text-primary underline-offset-4 hover:underline"
      >
        {t("viewAll")}
        <ArrowRight aria-hidden="true" className="size-4" />
      </Link>
    </div>
  );
}
