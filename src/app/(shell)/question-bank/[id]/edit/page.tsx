import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, History } from "lucide-react";
import { PageContainer } from "@/components/shell/PageContainer";
import { PageHeader } from "@/components/shell/PageHeader";
import { QuestionEditor } from "@/features/review/ui/QuestionEditor";
import { getEditableQuestion } from "@/features/review";
import { safeReturnTo } from "@/lib/navigation/return-to";
import { requireAllowedUser } from "@/features/auth";
import { runAsUser } from "@/lib/db/client";
import { getDb } from "@/lib/db/runtime";
import { isUuid } from "@/lib/jobs/status";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("review.edit");
  return { title: t("heading") };
}

export default async function EditQuestionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const user = await requireAllowedUser();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { next } = await searchParams;

  // Unknown, foreign and trashed ids all come back null.
  const editable = await runAsUser(getDb(), user.userId, (tx) =>
    getEditableQuestion(tx, { ownerId: user.userId, questionId: id }),
  );
  if (!editable) notFound();

  const t = await getTranslations("review.edit");
  const bankT = await getTranslations("bank");
  const returnTo = safeReturnTo(
    next,
    editable.banked ? `/question-bank/${id}` : "/generate",
  );
  return (
    <PageContainer width="narrow" className="flex flex-col">
      <div>
        <Link
          href={returnTo}
          className="mb-3 inline-flex min-h-11 items-center gap-2 rounded-lg text-sm font-semibold text-primary hover:underline"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {t("back")}
        </Link>
        <PageHeader title={t("heading")} description={t("description")} />
        <Link
          href={`/question-bank/${id}/history`}
          className="mb-4 inline-flex min-h-11 items-center gap-2 rounded-lg text-sm font-semibold text-primary hover:underline"
        >
          <History aria-hidden="true" className="size-4" />
          {bankT("historyLink")}
        </Link>
      </div>
      <QuestionEditor
        // A new row version (after a reload) remounts the editor on the new server content.
        key={editable.rowVersion}
        questionId={editable.questionId}
        rowVersion={editable.rowVersion}
        initial={editable.content}
        approved={editable.approved}
        banked={editable.banked}
        returnTo={returnTo}
      />
    </PageContainer>
  );
}
