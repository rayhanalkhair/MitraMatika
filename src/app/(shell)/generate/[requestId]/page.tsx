import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageContainer } from "@/components/shell/PageContainer";
import { PageHeader } from "@/components/shell/PageHeader";
import { RequestStatus } from "@/features/generation/ui/RequestStatus";
import { ReviewList } from "@/features/review/ui/ReviewList";
import { assessmentReturnTo } from "@/lib/navigation/return-to";
import { parseRequestSummary } from "@/features/generation";
import { requireAllowedUser } from "@/features/auth";
import { runAsUser } from "@/lib/db/client";
import { getDb } from "@/lib/db/runtime";
import { generationRequests } from "@/lib/db/schema";
import { isUuid } from "@/lib/jobs/status";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("generate");
  return { title: t("status.pageHeading") };
}

export default async function RequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ requestId: string }>;
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const user = await requireAllowedUser();
  const { requestId } = await params;
  if (!isUuid(requestId)) notFound();
  // Created from an assessment editor: offer the way back (only an editor path passes).
  const returnTo = assessmentReturnTo((await searchParams).returnTo);

  // This read MUST stay on runAsUser: RLS (owner_id = auth.uid()) is what isolates teachers, so
  // another teacher's requestId returns no row and falls through to notFound().
  const rows = await runAsUser(getDb(), user.userId, (tx) =>
    tx
      .select({ params: generationRequests.params, jobId: generationRequests.jobId })
      .from(generationRequests)
      .where(eq(generationRequests.id, requestId))
      .limit(1),
  );
  const request = rows.at(0);
  if (!request) notFound();

  const summary = parseRequestSummary(request.params);
  const t = await getTranslations("generate");

  return (
    <PageContainer>
      <PageHeader title={t("status.pageHeading")} />
      <div className="flex flex-col gap-6">
        {summary && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border bg-card p-4 text-sm shadow-card sm:grid-cols-[auto_1fr_auto_1fr_auto_1fr]">
            <dt className="text-muted-foreground">{t("status.summaryTopic")}</dt>
            <dd className="font-medium break-words">{summary.topicTitle}</dd>
            <dt className="text-muted-foreground">{t("status.summaryQuantity")}</dt>
            <dd>{summary.quantity}</dd>
            <dt className="text-muted-foreground">{t("status.summaryDifficulty")}</dt>
            <dd>{t(`difficulties.${summary.difficulty}`)}</dd>
          </dl>
        )}
        <RequestStatus requestId={requestId} jobId={request.jobId} />
        <ReviewList requestId={requestId} jobId={request.jobId} />
        {returnTo && (
          <div className="flex flex-col gap-1 rounded-lg border border-primary/30 bg-card p-4 shadow-card">
            <p className="text-sm text-muted-foreground">
              {t("status.backToAssessmentHint")}
            </p>
            <Link
              href={returnTo}
              className="inline-flex min-h-11 items-center text-sm font-semibold text-primary underline underline-offset-4"
            >
              {t("status.backToAssessment")}
            </Link>
          </div>
        )}
        <Link
          href="/generate"
          className="inline-flex min-h-11 items-center text-sm font-semibold text-primary underline underline-offset-4"
        >
          {t("status.back")}
        </Link>
      </div>
    </PageContainer>
  );
}
