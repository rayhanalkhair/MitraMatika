import { useTranslations } from "next-intl";
import { Search } from "lucide-react";
import type { BankQuery } from "../schema/bank-query";
import { BANK_PATH, bankParams } from "./bank-href";

// A plain GET form: Enter submits it, and the hidden fields carry every other filter and the sort.
export function BankSearch({ query }: { query: BankQuery }) {
  const t = useTranslations("bank.search");
  return (
    <form method="get" action={BANK_PATH} role="search" className="flex min-w-0 gap-2">
      {bankParams(query, ["q", "page"]).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <div className="relative min-w-0 flex-1">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="search"
          name="q"
          defaultValue={query.q ?? ""}
          maxLength={100}
          aria-label={t("label")}
          placeholder={t("placeholder")}
          className="min-h-11 w-full min-w-0 rounded-lg border bg-card pr-3 pl-9 text-sm"
        />
      </div>
      <button
        type="submit"
        className="inline-flex min-h-11 shrink-0 items-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors duration-150 hover:bg-primary-hover"
      >
        {t("submit")}
      </button>
    </form>
  );
}
