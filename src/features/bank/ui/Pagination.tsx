import { useTranslations } from "next-intl";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BankQuery } from "../schema/bank-query";
import { bankHref } from "./bank-href";

const CELL =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border px-3 text-sm font-medium transition-colors duration-150";

// Page numbers to show: first, last, the current page and its neighbours; gaps become null.
export function pageWindow(page: number, pageCount: number): (number | null)[] {
  const wanted = new Set([1, pageCount, page - 1, page, page + 1]);
  const pages = [...wanted].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b);
  const out: (number | null)[] = [];
  let previous = 0;
  for (const n of pages) {
    if (previous > 0 && n - previous > 1) out.push(null);
    out.push(n);
    previous = n;
  }
  return out;
}

export function Pagination({
  query,
  page,
  pageCount,
  total,
  shown,
  pageSize,
}: {
  query: BankQuery;
  page: number;
  pageCount: number;
  total: number;
  shown: number;
  pageSize: number;
}) {
  const t = useTranslations("bank.pagination");
  if (total === 0) return null;
  const first = (page - 1) * pageSize + 1;
  const last = first + shown - 1;
  return (
    <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
      <p className="text-sm text-muted-foreground">
        {t("showing", { first, last, total })}
      </p>
      {pageCount > 1 && (
        <nav aria-label={t("label")}>
          <ul className="flex flex-wrap items-center justify-center gap-2">
            {page > 1 && (
              <li>
                <Link
                  href={bankHref(query, { page: page - 1 })}
                  rel="prev"
                  className={cn(CELL, "gap-1 bg-card hover:bg-accent")}
                >
                  <ChevronLeft aria-hidden="true" className="size-4" />
                  {t("previous")}
                </Link>
              </li>
            )}
            {pageWindow(page, pageCount).map((n, i) => (
              <li key={n ?? `gap-${String(i)}`}>
                {n === null ? (
                  <span aria-hidden="true" className="px-1 text-muted-foreground">
                    …
                  </span>
                ) : (
                  <Link
                    href={bankHref(query, { page: n })}
                    aria-label={t("page", { page: n })}
                    aria-current={n === page ? "page" : undefined}
                    className={cn(
                      CELL,
                      n === page
                        ? "border-primary bg-primary text-primary-foreground"
                        : "bg-card hover:bg-accent",
                    )}
                  >
                    {n}
                  </Link>
                )}
              </li>
            ))}
            {page < pageCount && (
              <li>
                <Link
                  href={bankHref(query, { page: page + 1 })}
                  rel="next"
                  className={cn(CELL, "gap-1 bg-card hover:bg-accent")}
                >
                  {t("next")}
                  <ChevronRight aria-hidden="true" className="size-4" />
                </Link>
              </li>
            )}
          </ul>
        </nav>
      )}
    </div>
  );
}
