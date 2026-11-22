import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageContainer } from "@/components/shell/PageContainer";
import { PageHeader } from "@/components/shell/PageHeader";
import { getVersionHistory, getVersionQuestion } from "@/features/bank";
import { VersionHistory } from "@/features/bank/ui/VersionHistory";
import { requireAllowedUser } from "@/features/auth";
import { runAsUser } from "@/lib/db/client";
import { getDb } from "@/lib/db/runtime";
import { isUuid } from "@/lib/jobs/status";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("bank.history");
  return { title: t("title") };
}

export default async function QuestionHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ version?: string | string[] }>;
}) {
  const user = await requireAllowedUser();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { version } = await searchParams;
  const versionId = typeof version === "string" && isUuid(version) ? version : undefined;

  // Unknown, foreign and trashed questions come back null (reads run under RLS, owner explicit).
  const loaded = await runAsUser(getDb(), user.userId, async (tx) => {
    const history = await getVersionHistory(tx, { ownerId: user.userId, questionId: id });
    if (!history) return null;
    const selected = versionId
      ? await getVersionQuestion(tx, {
          ownerId: user.userId,
          questionId: id,
          versionId,
        })
      : null;
    return { history, selected };
  });
  if (!loaded) notFound();

  const t = await getTranslations("bank.history");
  const { history, selected } = loaded;
  return (
    <PageContainer width="narrow" className="flex flex-col">
      <div>
        <Link
          href={`/question-bank/${id}${history.banked ? "" : "/edit"}`}
          className="mb-3 inline-flex min-h-11 items-center gap-2 rounded-lg text-sm font-semibold text-primary hover:underline"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {t("back")}
        </Link>
        <PageHeader title={t("heading")} description={t("description")} />
      </div>
      <VersionHistory
        key={selected ? versionId : "none"}
        questionId={id}
        rowVersion={history.rowVersion}
        versions={history.versions}
        selected={selected}
        selectedId={selected ? versionId : undefined}
        historyPath={`/question-bank/${id}/history`}
      />
    </PageContainer>
  );
}
