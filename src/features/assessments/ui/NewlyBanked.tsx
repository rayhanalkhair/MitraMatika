import { useTranslations } from "next-intl";
import Link from "next/link";
import { useId } from "react";
import { Sparkles } from "lucide-react";
import type { BankedSinceItem } from "../service/picker";
import { PickList } from "./PickList";
import { linkButton } from "./styles";
import type { RunEditorAction } from "./use-editor-run";

/**
 * The offer after the teacher created questions for this assessment in /generate: the ones banked
 * since then that the assessment does not hold yet, all checked, to add in one go.
 */
export function NewlyBanked({
  assessmentId,
  basePath,
  offered,
  sections,
  locked,
  busy,
  run,
}: {
  assessmentId: string;
  basePath: string;
  offered: BankedSinceItem[];
  sections: { id: string; title: string }[];
  locked: boolean;
  busy: boolean;
  run: RunEditorAction;
}) {
  const t = useTranslations("assessments");
  const tr = useTranslations("review");
  const headingId = useId();
  if (offered.length === 0 || locked || sections.length === 0) return null;
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-ai/30 bg-ai-soft p-4"
    >
      <h2
        id={headingId}
        className="flex items-center gap-2 font-heading text-lg font-bold text-ai-foreground"
      >
        <Sparkles aria-hidden="true" className="size-5" />
        {t("offer.heading")}
      </h2>
      <p className="text-sm text-ai-foreground">
        {t("offer.description", { count: offered.length })}
      </p>
      <PickList
        assessmentId={assessmentId}
        items={offered.map((item) => ({
          questionId: item.questionId,
          stemExcerptMd: item.stemExcerptMd,
          meta: tr(`difficulty.${item.difficulty}`),
          added: false,
        }))}
        sections={sections}
        initialSectionId={sections[0].id}
        preselect
        focusAfterAdd="editor-outline"
        locked={locked}
        busy={busy}
        run={run}
      />
      <Link href={basePath} className={linkButton}>
        {t("offer.dismiss")}
      </Link>
    </section>
  );
}
