import { useTranslations } from "next-intl";
import Link from "next/link";
import { Plus } from "lucide-react";

// The page's one filled button. On first use it sits in a card with a hint; afterwards it stands alone.
export function QuickAction({ first }: { first: boolean }) {
  const t = useTranslations("beranda");
  const link = (
    <Link
      href="/generate"
      className="inline-flex min-h-11 min-w-0 items-center justify-center gap-2 self-start rounded-lg bg-primary px-6 py-3 text-base font-semibold text-primary-foreground transition-colors duration-150 hover:bg-primary-hover"
    >
      <Plus aria-hidden="true" className="size-5 shrink-0" />
      <span className="break-words">
        {first ? t("quickActionFirst") : t("quickAction")}
      </span>
    </Link>
  );
  if (!first) return link;
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-6 shadow-card">
      <p className="text-secondary-foreground">{t("quickActionHint")}</p>
      {link}
    </div>
  );
}
