import { useTranslations } from "next-intl";
import { ChevronDown } from "lucide-react";
import { CurriculumChip } from "@/components/curriculum/CurriculumChip";
import type { RequestReview } from "@/features/review/service/review";

export function CurriculumPanel({
  curriculum,
}: {
  curriculum: NonNullable<RequestReview["curriculum"]>;
}) {
  const t = useTranslations("review.curriculum");
  return (
    <details className="group rounded-lg border bg-card p-4 shadow-card">
      <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 text-sm font-medium">
        {t("summary")}
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 transition-transform group-open:rotate-180"
        />
      </summary>
      <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">{t("element")}</dt>
        <dd className="min-w-0 break-words">{curriculum.elementName}</dd>
        <dt className="text-muted-foreground">{t("topic")}</dt>
        <dd className="min-w-0 break-words">{curriculum.topicTitle}</dd>
        <dt className="text-muted-foreground">{t("objectives")}</dt>
        <dd className="min-w-0">
          <ul className="flex list-disc flex-col gap-1 pl-5">
            {curriculum.objectives.map((objective) => (
              <li key={objective.code} className="break-words">
                <CurriculumChip code={objective.code} /> {objective.text}
              </li>
            ))}
          </ul>
        </dd>
        {curriculum.sourceAnchor && (
          <>
            <dt className="text-muted-foreground">{t("source")}</dt>
            <dd className="min-w-0 break-words">{curriculum.sourceAnchor}</dd>
          </>
        )}
        <dt className="text-muted-foreground">{t("version")}</dt>
        <dd className="min-w-0 break-words">
          {curriculum.versionCode} — {curriculum.versionTitle}
        </dd>
      </dl>
    </details>
  );
}
