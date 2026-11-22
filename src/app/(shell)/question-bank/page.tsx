import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { BankList } from "@/features/bank/ui/BankList";
import {
  BANK_PAGE_SIZE,
  bankQuerySchema,
  getBankCount,
  getBankList,
} from "@/features/bank";
import { ActiveFilters, BankFilters } from "@/features/bank/ui/BankFilters";
import { BankSearch } from "@/features/bank/ui/BankSearch";
import { Pagination } from "@/features/bank/ui/Pagination";
import { BANK_PATH, bankHref, hasActiveFilters } from "@/features/bank/ui/bank-href";
import { PageContainer } from "@/components/shell/PageContainer";
import { PageHeader } from "@/components/shell/PageHeader";
import { requireAllowedUser } from "@/features/auth";
import { runAsUser } from "@/lib/db/client";
import { getDb } from "@/lib/db/runtime";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("bank");
  return { title: t("heading") };
}

export default async function BankSoalPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations("bank");
  const user = await requireAllowedUser();
  // A bad or unknown param falls back to its default; the page never errors on a hand-edited link.
  const query = bankQuerySchema.parse(await searchParams);
  const filtered = hasActiveFilters(query);
  // Under runAsUser so RLS applies on top of the owner filter inside the read model.
  const { list, bankTotal } = await runAsUser(getDb(), user.userId, async (tx) => {
    const list = await getBankList(tx, { ownerId: user.userId, query });
    // Unfiltered, the list total is the whole bank; only a filter needs its own count.
    const bankTotal = filtered
      ? await getBankCount(tx, { ownerId: user.userId })
      : list.total;
    return { list, bankTotal };
  });

  return (
    <PageContainer>
      <PageHeader
        title={t("heading")}
        description={t("subtitle")}
        actions={
          bankTotal > 0 ? (
            <Link
              href="/generate"
              className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors duration-150 hover:bg-primary-hover"
            >
              <Plus aria-hidden="true" className="size-4" />
              {t("create")}
            </Link>
          ) : null
        }
      />
      <div className="flex min-w-0 flex-col gap-6">
        {bankTotal > 0 && (
          <div className="flex min-w-0 flex-col gap-3">
            <BankSearch query={query} />
            <BankFilters key={bankHref(query)} query={query} facets={list.facets} />
            <ActiveFilters query={query} facets={list.facets} />
          </div>
        )}
        <BankList items={list.items} bankTotal={bankTotal} resetHref={BANK_PATH} />
        <Pagination
          query={query}
          page={list.page}
          pageCount={list.pageCount}
          total={list.total}
          shown={list.items.length}
          pageSize={BANK_PAGE_SIZE}
        />
      </div>
    </PageContainer>
  );
}
