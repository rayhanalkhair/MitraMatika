import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { PageContainer } from "@/components/shell/PageContainer";
import { PageHeader } from "@/components/shell/PageHeader";
import { requireAllowedUser } from "@/features/auth";
import { createCurriculumRepository } from "@/features/curriculum";
import {
  getMaterialDetail,
  getReviewPage,
  latestStructureJob,
  listFolders,
  listReviewPages,
  ocrPagesLeft,
  visionReadsLeft,
  type MaterialDb,
} from "@/features/materials";
import { MaterialDetail } from "@/features/materials/ui/MaterialDetail";
import { OcrReview } from "@/features/materials/ui/OcrReview";
import { OcrSelector } from "@/features/materials/ui/OcrSelector";
import { StructureEditor } from "@/features/materials/ui/StructureEditor";
import { runAsUser } from "@/lib/db/client";
import { getDb } from "@/lib/db/runtime";
import { isUuid } from "@/lib/jobs/status";

// "Suggest with AI" and "OCR selected pages" schedule the job runner in their Server Actions, which
// run within this page's time limit (Next 16: a Server Action runs within its page's maxDuration).
export const maxDuration = 300;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t("nav.materi") };
}

/** The page the review opens: the one asked for (clamped), else the first that needs checking. */
function chosenPage(
  asked: string | string[] | undefined,
  pages: { pageNo: number; confidence: string }[],
): number | null {
  if (pages.length === 0) return null;
  const last = pages[pages.length - 1].pageNo;
  const value = Number(Array.isArray(asked) ? asked[0] : asked);
  if (Number.isSafeInteger(value) && value >= 1) return Math.min(value, last);
  return pages.find((page) => page.confidence !== "high")?.pageNo ?? pages[0].pageNo;
}

export default async function MaterialPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations("materials");
  const user = await requireAllowedUser();
  const { id } = await params;
  const { page: askedPage } = await searchParams;
  if (!isUuid(id)) notFound();

  // Unknown, foreign and trashed ids all come back null (RLS on top of the owner filter).
  const loaded = await runAsUser(getDb(), user.userId, async (rawTx) => {
    const tx = rawTx as unknown as MaterialDb;
    const ownerId = user.userId;
    const detail = await getMaterialDetail(tx, { ownerId, materialId: id });
    if (!detail) return null;
    const curriculum = createCurriculumRepository(tx);
    const topics = (
      await Promise.all(([7, 8, 9] as const).map((grade) => curriculum.listTopics(grade)))
    )
      .flat()
      .map((topic) => ({ id: topic.id, title: topic.title, grade: topic.grade }));
    const pages = await listReviewPages(tx, { ownerId, materialId: id });
    const pageNo = chosenPage(askedPage, pages);
    return {
      detail,
      topics,
      folders: await listFolders(tx, { ownerId }),
      job: await latestStructureJob(tx, { ownerId, materialId: id }),
      pages,
      page:
        pageNo === null
          ? null
          : await getReviewPage(tx, { ownerId, materialId: id, pageNo }),
      ocrLeft: await ocrPagesLeft(tx, { ownerId, now: new Date() }),
      visionLeft: await visionReadsLeft(tx, { ownerId, now: new Date() }),
    };
  });
  if (!loaded) notFound();
  const { detail, topics, folders, job, pages, page, ocrLeft, visionLeft } = loaded;
  const { proposal, sections, ...facts } = detail;
  const read = detail.status === "ready" || detail.status === "needs_review";
  const unsure = pages.filter((entry) => entry.confidence !== "high");
  const nextFlagged = page
    ? ((unsure.find((entry) => entry.pageNo > page.pageNo) ?? unsure.at(0))?.pageNo ??
      null)
    : null;

  return (
    <PageContainer>
      <Link
        href="/materials"
        className="mb-4 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        {t("detail.back")}
      </Link>
      <PageHeader title={detail.title} />
      <div className="flex min-w-0 flex-col gap-6">
        <MaterialDetail detail={facts} folders={folders} />
        <StructureEditor
          // A new proposal starts the form from its values; a save keeps the form as it is.
          key={proposal?.proposedAt ?? "none"}
          materialId={detail.id}
          status={detail.status}
          pageCount={detail.pageCount}
          saved={{
            title: detail.title,
            grade: detail.grade,
            academicYear: detail.academicYear,
            metadataConfirmedAt: detail.metadataConfirmedAt,
            sections,
          }}
          proposal={proposal}
          topics={topics}
          job={job}
        />
        {read && detail.kind !== "docx" && (
          <OcrSelector
            materialId={detail.id}
            kind={detail.kind}
            sizeBytes={detail.sizeBytes}
            pages={pages.map(({ pageNo, ocrStatus, textSource }) => ({
              pageNo,
              ocrStatus,
              textSource,
            }))}
            left={ocrLeft}
            visionLeft={visionLeft}
          />
        )}
        {read && page && (
          <OcrReview
            // A new page starts its own editor; new text of the same page (a save, an OCR run)
            // keeps it mounted (OcrReview takes the stored text), and with it the viewer's
            // document and the saved notice.
            key={String(page.pageNo)}
            materialId={detail.id}
            kind={detail.kind}
            total={pages.length}
            page={{
              pageNo: page.pageNo,
              textMd: page.textMd,
              confidence: page.confidence,
              flags: page.flags,
              ocrStatus: page.ocrStatus,
              textSource: page.textSource,
            }}
            nextFlagged={nextFlagged === page.pageNo ? null : nextFlagged}
          />
        )}
      </div>
    </PageContainer>
  );
}
