import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BankDetail } from "@/features/bank/ui/BankDetail";
import { getBankQuestion } from "@/features/bank";
import { requireAllowedUser } from "@/features/auth";
import { runAsUser } from "@/lib/db/client";
import { getDb } from "@/lib/db/runtime";
import { isUuid } from "@/lib/jobs/status";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("bank");
  return { title: t("detailTitle") };
}

export default async function BankQuestionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireAllowedUser();
  const { id } = await params;
  if (!isUuid(id)) notFound();

  // Unknown, foreign, unbanked, rejected and stale ids all come back null.
  const bankQuestion = await runAsUser(getDb(), user.userId, (tx) =>
    getBankQuestion(tx, { ownerId: user.userId, questionId: id }),
  );
  if (!bankQuestion) notFound();

  return <BankDetail bankQuestion={bankQuestion} />;
}
