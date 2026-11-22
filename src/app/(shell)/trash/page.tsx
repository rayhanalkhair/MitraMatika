import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PageContainer } from "@/components/shell/PageContainer";
import { PageHeader } from "@/components/shell/PageHeader";
import { requireAllowedUser } from "@/features/auth";
import {
  listTrash,
  listTrashedAssessments,
  listTrashedFolders,
  listTrashedMaterials,
  listTrashedSolverSessions,
  listTrashedTemplates,
} from "@/features/trash";
import { TrashList } from "@/features/trash/ui/TrashList";
import { runAsUser } from "@/lib/db/client";
import { getDb } from "@/lib/db/runtime";

// Restoring a material whose text was not fully read starts the job runner in its Server Action,
// which runs within this page's time limit (Next 16).
export const maxDuration = 300;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("trash");
  return { title: t("title") };
}

export default async function SampahPage() {
  const t = await getTranslations("trash");
  const user = await requireAllowedUser();
  // Under runAsUser so RLS applies on top of the owner filter inside each read model.
  const { items, assessments, templates, materials, folders, solverSessions } =
    await runAsUser(getDb(), user.userId, async (tx) => {
      const input = { ownerId: user.userId, now: new Date() };
      return {
        items: await listTrash(tx, input),
        assessments: await listTrashedAssessments(tx, input),
        templates: await listTrashedTemplates(tx, input),
        materials: await listTrashedMaterials(tx, input),
        folders: await listTrashedFolders(tx, input),
        solverSessions: await listTrashedSolverSessions(tx, input),
      };
    });
  return (
    <PageContainer width="narrow">
      <PageHeader title={t("heading")} description={t("description")} />
      <TrashList
        items={items}
        assessments={assessments}
        templates={templates}
        materials={materials}
        folders={folders}
        solverSessions={solverSessions}
      />
    </PageContainer>
  );
}
