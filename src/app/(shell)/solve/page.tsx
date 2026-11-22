import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PageContainer } from "@/components/shell/PageContainer";
import { PageHeader } from "@/components/shell/PageHeader";
import { requireAllowedUser } from "@/features/auth";
import { visionReadsLeft } from "@/features/materials";
import { listRecentSessions, solvesLeft, type SolverDb } from "@/features/solver";
import { RecentSessions } from "@/features/solver/ui/RecentSessions";
import { SolverInput } from "@/features/solver/ui/SolverInput";
import { runAsUser } from "@/lib/db/client";
import { getDb } from "@/lib/db/runtime";

// Solving a typed problem schedules the job runner in its Server Action, which runs within this
// page's time limit (Next 16: a Server Action runs within its page's maxDuration).
export const maxDuration = 300;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t("nav.selesaikan") };
}

export default async function SelesaikanPage() {
  const t = await getTranslations("solve");
  const user = await requireAllowedUser();
  // Under runAsUser so RLS applies on top of the owner filter inside each read.
  const { recent, left, visionLeft } = await runAsUser(
    getDb(),
    user.userId,
    async (tx) => {
      const db = tx as unknown as SolverDb;
      return {
        recent: await listRecentSessions(db, { ownerId: user.userId }),
        left: await solvesLeft(db, { ownerId: user.userId, now: new Date() }),
        visionLeft: await visionReadsLeft(tx, {
          ownerId: user.userId,
          now: new Date(),
        }),
      };
    },
  );
  return (
    <PageContainer>
      <PageHeader title={t("title")} description={t("description")} />
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <SolverInput solvesLeft={left} visionLeft={visionLeft} />
          <RecentSessions sessions={recent} />
        </div>
        <section
          aria-labelledby="solve-how"
          className="flex min-w-0 flex-col gap-3 rounded-lg border border-dashed bg-card p-6"
        >
          <h2 id="solve-how" className="font-heading text-lg font-bold">
            {t("how.heading")}
          </h2>
          <ol className="list-decimal space-y-2 ps-5 text-sm text-muted-foreground">
            <li>{t("how.input")}</li>
            <li>{t("how.confirm")}</li>
            <li>{t("how.verify")}</li>
            <li>{t("how.another")}</li>
          </ol>
        </section>
      </div>
    </PageContainer>
  );
}
