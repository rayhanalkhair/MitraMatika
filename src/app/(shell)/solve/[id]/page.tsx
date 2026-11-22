import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { PageContainer } from "@/components/shell/PageContainer";
import { PageHeader } from "@/components/shell/PageHeader";
import { requireAllowedUser } from "@/features/auth";
import { getSession, listRecentSessions, type SolverDb } from "@/features/solver";
import { RecentSessions } from "@/features/solver/ui/RecentSessions";
import { SolutionView } from "@/features/solver/ui/SolutionView";
import { TrashSolverSessionButton } from "@/features/trash/ui/TrashSolverSessionButton";
import { runAsUser } from "@/lib/db/client";
import { getDb } from "@/lib/db/runtime";
import { isUuid } from "@/lib/jobs/status";

// Confirming a reading, solving again and "show another method" schedule the job runner in their
// Server Actions, which run within this page's time limit.
export const maxDuration = 300;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t("nav.selesaikan") };
}

export default async function SolveSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const t = await getTranslations("solve");
  const user = await requireAllowedUser();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { session, recent } = await runAsUser(getDb(), user.userId, async (tx) => {
    const db = tx as unknown as SolverDb;
    return {
      session: await getSession(db, { ownerId: user.userId, sessionId: id }),
      recent: await listRecentSessions(db, { ownerId: user.userId }),
    };
  });
  if (!session) notFound();
  return (
    <PageContainer>
      <Link
        href="/solve"
        className="mb-4 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        {t("newProblem")}
      </Link>
      <PageHeader
        title={t("sessionTitle")}
        actions={<TrashSolverSessionButton sessionId={session.id} />}
      />
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <SolutionView session={session} />
        <RecentSessions sessions={recent} currentId={session.id} />
      </div>
    </PageContainer>
  );
}
