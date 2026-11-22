import { useTranslations } from "next-intl";
import Link from "next/link";
import { CircleCheck, CircleDashed } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PendingItem } from "@/features/beranda/service/dashboard";

export function PendingList({ items }: { items: PendingItem[] }) {
  const t = useTranslations("beranda");
  if (items.length === 0) {
    return (
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <CircleCheck aria-hidden="true" className="size-5 shrink-0 text-success" />
        <p>{t("pending.empty")}</p>
      </div>
    );
  }
  return (
    <ul className="flex min-w-0 flex-col gap-3">
      {items.map((item) => (
        <li key={item.requestId}>
          <Link
            href={`/generate/${item.requestId}`}
            className={cn(
              "flex min-h-11 min-w-0 flex-col gap-1 rounded-lg border border-l-4 bg-card p-4 transition-colors duration-150 hover:bg-accent/40",
              item.undecided > 0 ? "border-l-warning" : "border-l-success",
            )}
          >
            <span className="min-w-0 font-heading font-semibold break-words">
              {item.topicTitle ?? t("unknownTopic")}
            </span>
            <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              {item.undecided > 0 && (
                <span className="flex items-center gap-1.5">
                  <CircleDashed aria-hidden="true" className="size-4 shrink-0" />
                  {t("pending.undecided", { count: String(item.undecided) })}
                </span>
              )}
              {item.readyToSave > 0 && (
                <span className="flex items-center gap-1.5">
                  <CircleCheck
                    aria-hidden="true"
                    className="size-4 shrink-0 text-success"
                  />
                  {t("pending.ready", { count: String(item.readyToSave) })}
                </span>
              )}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
