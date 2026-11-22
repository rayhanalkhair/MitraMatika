import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { PageContainer } from "@/components/shell/PageContainer";
import { PageHeader } from "@/components/shell/PageHeader";
import {
  getApprovalState,
  getAssessmentEditor,
  isUuid,
  listBankedSince,
  loadPicker,
  type AssessmentDb,
} from "@/features/assessments";
import {
  AssessmentEditor,
  type PickerData,
} from "@/features/assessments/ui/AssessmentEditor";
import { requireAllowedUser } from "@/features/auth";
import { bankQuerySchema } from "@/features/bank";
import { getExportPanel } from "@/features/export";
import { ExportPanel } from "@/features/export/ui/ExportPanel";
import { listTemplates } from "@/features/templates";
import { TrashAssessmentButton } from "@/features/trash/ui/TrashAssessmentButton";
import { generateHref, parseSince } from "@/lib/navigation/return-to";
import { runAsUser } from "@/lib/db/client";
import { getDb } from "@/lib/db/runtime";

// The export panel's action schedules the job runner after its response, inside this page's
// time limit (Next 16: a Server Action runs within its page's maxDuration), and the runner prints
// the PDFs here (React-PDF, ADR-0021, runs in any function).
export const maxDuration = 300;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t("nav.penyusunAsesmen") };
}

type SearchParams = Record<string, string | string[] | undefined>;

export default async function AssessmentEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireAllowedUser();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const raw = await searchParams;
  const pick = typeof raw.pick === "string" ? raw.pick : undefined;
  const since = parseSince(raw.since);
  const query = bankQuerySchema.parse(raw);

  // One transaction under RLS as the signed-in teacher; every read also names the owner.
  const loaded = await runAsUser(getDb(), user.userId, async (tx) => {
    const db = tx as unknown as AssessmentDb;
    const ownerId = user.userId;
    const view = await getAssessmentEditor(db, { ownerId, assessmentId: id });
    if (!view) return null;
    const open = view.assessment.status === "draft";
    const pickSection = open && view.sections.find((section) => section.id === pick);
    const picker: PickerData | null = pickSection
      ? await loadPicker(db, { ownerId, assessmentId: id, query }).then((result) =>
          result
            ? {
                sectionId: pickSection.id,
                query,
                list: result.list,
                added: result.added,
                pending: result.pending,
              }
            : null,
        )
      : null;
    const offered =
      open && since
        ? await listBankedSince(db, { ownerId, assessmentId: id, since })
        : [];
    const templates = await listTemplates(db, ownerId);
    const approval = await getApprovalState(db, { ownerId, assessmentId: id });
    if (!approval) return null;
    // Only an approved assessment that still passes the export gate can be exported, and the
    // panel shows only what was exported for this approval (R27: not stale, so the current hash
    // is the stored one).
    const exportPanel =
      approval.approved && !approval.stale
        ? await getExportPanel(db, {
            ownerId,
            assessmentId: id,
            snapshotHash: approval.hash,
            now: new Date(),
          })
        : null;
    return { view, picker, offered, templates, approval, exportPanel };
  });
  if (!loaded) notFound();

  const { view, picker, offered, templates, approval, exportPanel } = loaded;
  return (
    <PageContainer>
      <PageHeader
        title={view.assessment.title}
        eyebrow={(await getTranslations("nav"))("penyusunAsesmen")}
        actions={
          <TrashAssessmentButton
            assessmentId={id}
            title={view.assessment.title}
            afterTrash="/assessment-builder"
          />
        }
      />
      <AssessmentEditor
        view={view}
        templates={templates.map(({ id: templateId, name, isDefault }) => ({
          id: templateId,
          name,
          isDefault,
        }))}
        generateHref={generateHref(id, new Date().toISOString())}
        picker={picker}
        offered={offered}
        approval={approval}
      />
      {exportPanel && (
        <div className="mt-6">
          <ExportPanel assessmentId={id} data={exportPanel} />
        </div>
      )}
    </PageContainer>
  );
}
