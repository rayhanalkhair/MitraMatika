import { useLocale, useTimeZone, useTranslations } from "next-intl";
import Link from "next/link";
import { ArrowLeft, History } from "lucide-react";
import { PageContainer } from "@/components/shell/PageContainer";
import { PageHeader } from "@/components/shell/PageHeader";
import { CurriculumPanel } from "@/features/review/ui/CurriculumPanel";
import { QuestionCard } from "@/features/review/ui/QuestionCard";
import { formatBankDate } from "@/lib/format-date";
import { DEFAULT_TIMEZONE } from "@/lib/timezone-shared";
import type { BankQuestion } from "@/features/bank/service/bank";
import { TrashQuestionButton } from "@/features/trash/ui/TrashQuestionButton";
import { BankRegenerate } from "./BankRegenerate";

export function BankDetail({ bankQuestion }: { bankQuestion: BankQuestion }) {
  const t = useTranslations("bank");
  const view = { locale: useLocale(), timeZone: useTimeZone() ?? DEFAULT_TIMEZONE };
  return (
    <PageContainer width="narrow" className="flex flex-col">
      <div>
        <Link
          href="/question-bank"
          className="mb-3 inline-flex min-h-11 items-center gap-2 rounded-lg text-sm font-semibold text-primary hover:underline"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {t("back")}
        </Link>
        <PageHeader
          title={t("detailHeading")}
          description={t("savedOn", {
            date: formatBankDate(bankQuestion.bankedAt, view),
          })}
        />
        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-1">
          <Link
            href={`/question-bank/${bankQuestion.question.questionId}/history`}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg text-sm font-semibold text-primary hover:underline"
          >
            <History aria-hidden="true" className="size-4" />
            {t("historyLink")}
          </Link>
          <TrashQuestionButton
            questionId={bankQuestion.question.questionId}
            topic={bankQuestion.curriculum?.topicTitle ?? t("questionHeading")}
            afterTrash="/question-bank"
          />
        </div>
      </div>
      {bankQuestion.curriculum && (
        <div className="mb-6">
          <CurriculumPanel curriculum={bankQuestion.curriculum} />
        </div>
      )}
      <QuestionCard
        number={1}
        question={bankQuestion.question}
        jobState="finished"
        heading={t("questionHeading")}
        readOnly
        editHref={`/question-bank/${bankQuestion.question.questionId}/edit`}
        footer={<BankRegenerate question={bankQuestion.question} />}
      />
    </PageContainer>
  );
}
