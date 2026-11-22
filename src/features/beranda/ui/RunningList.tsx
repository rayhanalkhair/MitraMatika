import { useLocale, useTimeZone, useTranslations } from "next-intl";
import Link from "next/link";
import { Clock, Loader } from "lucide-react";
import type { RunningItem } from "@/features/beranda/service/dashboard";
import { DEFAULT_TIMEZONE } from "@/lib/timezone-shared";
import { jobMessage } from "../service/ai-status";

export function RunningList({ items }: { items: RunningItem[] }) {
  const t = useTranslations("beranda");
  const tStatus = useTranslations("generate.status");
  const view = { locale: useLocale(), timeZone: useTimeZone() ?? DEFAULT_TIMEZONE };
  if (items.length === 0) {
    return (
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Clock aria-hidden="true" className="size-5 shrink-0" />
        <p>{t("running.empty")}</p>
      </div>
    );
  }
  return (
    <ul className="flex min-w-0 flex-col gap-3">
      {items.map((item) => {
        const message = jobMessage(item, tStatus, view);
        const Icon = item.jobStatus === "deferred" ? Clock : Loader;
        return (
          <li key={item.requestId}>
            <Link
              href={`/generate/${item.requestId}`}
              className="flex min-h-11 min-w-0 flex-col gap-1 rounded-lg border border-l-4 border-l-ai bg-card p-4 transition-colors duration-150 hover:bg-accent/40"
            >
              <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="min-w-0 font-heading font-semibold break-words">
                  {item.topicTitle ?? t("unknownTopic")}
                </span>
                {item.quantity !== null && (
                  <span className="text-sm text-muted-foreground">
                    {t("running.quantity", { count: item.quantity })}
                  </span>
                )}
              </span>
              <span className="flex min-w-0 items-start gap-2 text-sm">
                <Icon
                  aria-hidden="true"
                  className={`mt-0.5 size-4 shrink-0 ${
                    item.jobStatus === "deferred"
                      ? "text-warning"
                      : "text-primary motion-safe:animate-spin"
                  }`}
                />
                <span className="min-w-0 break-words">
                  {message.title}
                  {message.detail ? ` · ${message.detail}` : ""}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
