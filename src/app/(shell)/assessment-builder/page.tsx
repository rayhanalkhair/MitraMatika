import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PageContainer } from "@/components/shell/PageContainer";
import { PageHeader } from "@/components/shell/PageHeader";
import {
  listAssessments,
  type AssessmentDb,
  type AssessmentListItem,
} from "@/features/assessments";
import { AssessmentForm } from "@/features/assessments/ui/AssessmentForm";
import { AssessmentList } from "@/features/assessments/ui/AssessmentList";
import { requireAllowedUser } from "@/features/auth";
import { listTemplates, type TemplateDb } from "@/features/templates";
import { runAsUser } from "@/lib/db/client";
import { safeErrorSummary } from "@/lib/db/error-summary";
import { getDb } from "@/lib/db/runtime";
import { logger } from "@/lib/logger";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t("nav.penyusunAsesmen") };
}

// Under RLS as the signed-in teacher. A failed read says so on the page instead of erroring it.
async function load(userId: string) {
  try {
    return await runAsUser(getDb(), userId, async (tx) => ({
      items: await listAssessments(tx as unknown as AssessmentDb, userId),
      templates: await listTemplates(tx as unknown as TemplateDb, userId),
    }));
  } catch (error) {
    logger.error(
      { module: "assessments", err: safeErrorSummary(error) },
      "assessments: could not list the assessments",
    );
    return null;
  }
}

export default async function PenyusunAsesmenPage() {
  const t = await getTranslations();
  const user = await requireAllowedUser();
  const loaded = await load(user.userId);
  const items: AssessmentListItem[] = loaded?.items ?? [];

  return (
    <PageContainer>
      <PageHeader
        title={t("nav.penyusunAsesmen")}
        description={t("assessments.list.description")}
      />
      <div className="flex min-w-0 flex-col gap-8">
        <section
          aria-labelledby="new-assessment"
          className="flex min-w-0 flex-col gap-4 rounded-lg border bg-card p-5 shadow-card"
        >
          <h2 id="new-assessment" className="font-heading text-lg font-bold">
            {t("assessments.list.newHeading")}
          </h2>
          <AssessmentForm
            templates={(loaded?.templates ?? []).map(({ id, name, isDefault }) => ({
              id,
              name,
              isDefault,
            }))}
          />
        </section>
        <section
          aria-labelledby="your-assessments"
          className="flex min-w-0 flex-col gap-4"
        >
          <h2 id="your-assessments" className="font-heading text-lg font-bold">
            {t("assessments.list.listHeading")}
          </h2>
          {loaded ? (
            <AssessmentList items={items} />
          ) : (
            <p role="alert" className="text-sm text-destructive">
              {t("assessments.list.loadFailed")}
            </p>
          )}
        </section>
      </div>
    </PageContainer>
  );
}
