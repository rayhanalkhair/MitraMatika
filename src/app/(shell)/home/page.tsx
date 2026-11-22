import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { FileClock, Loader } from "lucide-react";
import { PageContainer } from "@/components/shell/PageContainer";
import { PageHeader } from "@/components/shell/PageHeader";
import { AiStatusLine } from "@/features/beranda/ui/AiStatusLine";
import { aiStatus } from "@/features/beranda";
import { BankCounter } from "@/features/beranda/ui/BankCounter";
import { PendingList } from "@/features/beranda/ui/PendingList";
import { QuickAction } from "@/features/beranda/ui/QuickAction";
import { RecentAssessments } from "@/features/beranda/ui/RecentAssessments";
import { RunningList } from "@/features/beranda/ui/RunningList";
import { SummaryTile } from "@/features/beranda/ui/SummaryTile";
import { getDashboard, getRecentAssessments } from "@/features/beranda";
import { requireAllowedUser } from "@/features/auth";
import { runAsUser } from "@/lib/db/client";
import { getDb } from "@/lib/db/runtime";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t("nav.beranda") };
}

export default async function BerandaPage() {
  const t = await getTranslations();
  const user = await requireAllowedUser();
  // Under runAsUser so RLS applies on top of the owner filter inside the read model.
  const { dashboard, recent } = await runAsUser(getDb(), user.userId, async (tx) => ({
    dashboard: await getDashboard(tx, { ownerId: user.userId }),
    recent: await getRecentAssessments(tx, { ownerId: user.userId }),
  }));
  const ai = aiStatus(dashboard.running);
  // The first word of the session name; without a name a neutral greeting, never the email.
  const firstName = user.displayName?.trim().split(/\s+/)[0];

  return (
    <PageContainer>
      <PageHeader
        title={
          firstName
            ? t("beranda.greeting", { name: firstName })
            : t("beranda.greetingNeutral")
        }
        description={t("beranda.subtitle")}
        status={<AiStatusLine kind={ai.kind} detail={ai.detail} />}
        actions={dashboard.hasActivity ? <QuickAction first={false} /> : undefined}
      />
      <div className="flex min-w-0 flex-col gap-6">
        {!dashboard.hasActivity && <QuickAction first />}
        <ul
          aria-label={t("beranda.tiles.label")}
          className="grid min-w-0 gap-4 sm:grid-cols-3"
        >
          <SummaryTile
            label={t("beranda.tiles.drafts")}
            value={dashboard.undecidedTotal}
            icon={<FileClock className="size-5" />}
          />
          <BankCounter count={dashboard.bankedCount} />
          <SummaryTile
            label={t("beranda.tiles.running")}
            value={dashboard.running.length}
            icon={<Loader className="size-5" />}
          />
        </ul>
        {/* One column on a phone and a narrow window; side by side once the content column is wide. */}
        <div className="grid min-w-0 gap-6 xl:grid-cols-2 xl:items-start">
          <section className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-5 shadow-card">
            <h2 className="font-heading text-lg font-bold">
              {t("beranda.pending.heading")}
            </h2>
            <PendingList items={dashboard.pending} />
          </section>
          <section className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-5 shadow-card">
            <h2 className="font-heading text-lg font-bold">
              {t("beranda.running.heading")}
            </h2>
            <RunningList items={dashboard.running} />
          </section>
        </div>
        <section className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-5 shadow-card">
          <h2 className="font-heading text-lg font-bold">
            {t("beranda.recent.heading")}
          </h2>
          <RecentAssessments items={recent} />
        </section>
      </div>
    </PageContainer>
  );
}
