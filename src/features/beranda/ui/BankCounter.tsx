import { useTranslations } from "next-intl";
import Link from "next/link";
import { Archive } from "lucide-react";
import { SummaryTile } from "./SummaryTile";

export function BankCounter({ count }: { count: number }) {
  const t = useTranslations("beranda");
  return (
    <SummaryTile
      label={t("tiles.bank")}
      value={count}
      icon={<Archive className="size-5" />}
    >
      {count > 0 && (
        <Link
          href="/question-bank"
          className="inline-flex min-h-11 items-center self-start rounded-lg text-sm font-semibold text-primary underline underline-offset-4 transition-colors duration-150 hover:text-primary/80"
        >
          {t("bank.open")}
        </Link>
      )}
    </SummaryTile>
  );
}
