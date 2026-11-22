import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { PageContainer } from "@/components/shell/PageContainer";
import { PageHeader } from "@/components/shell/PageHeader";
import { allNavItems } from "@/components/shell/nav-config";
import { UserCard } from "@/components/shell/UserCard";
import { StatusPill } from "@/components/ui/status-pill";
import { requireAllowedUser } from "@/features/auth";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("lainnya") };
}

// The mobile overflow menu: everything the bottom bar has no room for. On desktop the sidebar
// already lists these, and the page still renders if someone opens /more there.
export default async function LainnyaPage() {
  const t = await getTranslations();
  const user = await requireAllowedUser();
  const overflowItems = allNavItems.filter(
    (item) => !item.mobileBottomNav && item.href !== "/more",
  );

  return (
    <PageContainer width="narrow">
      <PageHeader title={t("nav.lainnya")} />
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border border-border bg-card p-3 shadow-card md:hidden [&>div]:border-t-0 [&>div]:pt-0">
          <UserCard name={user.displayName} email={user.email} />
        </div>
        <ul className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
          {overflowItems.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.href} className="border-b border-border last:border-b-0">
                <Link
                  href={item.href}
                  className="flex min-h-14 items-center gap-3 px-4 py-2 text-sm font-medium text-foreground transition-colors duration-150 hover:bg-secondary"
                >
                  <span
                    aria-hidden="true"
                    className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-primary"
                  >
                    <Icon className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {t(`nav.${item.labelKey}`)}
                  </span>
                  {item.comingSoon ? (
                    <StatusPill tone="neutral" className="min-h-6 px-2 text-xs">
                      {t("common.soonBadge")}
                    </StatusPill>
                  ) : null}
                  <ChevronRight
                    className="size-5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </PageContainer>
  );
}
