import "server-only";
// The review of a material's pages (decision 7): the page list and one page's text for the
// review screen, and the teacher's correction (text_source `manual`).
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { materialPages, materials } from "@/lib/db/schema";
import { err, ok, type Result } from "@/lib/result";
import { MAX_MANUAL_PAGE_CHARS, type SavePageTextError } from "../schema/ocr";
import { cleanPageText } from "./page-quality";
import type { MaterialDb } from "./upload";
import {
  liveJobListsPage,
  liveMaterial,
  OCR_UUID as UUID,
  shownOcrStatus,
} from "./ocr-queue";
// ---------------------------------------------------------------------------------------------
// Manual corrections and the review reads

/** ready when every page is high, else needs_review (only for a material that was read). */
export async function refreshMaterialStatus(
  db: MaterialDb,
  input: { ownerId: string; materialId: string; now: Date },
): Promise<void> {
  const unsure = sql`exists (select 1 from ${materialPages}
    where ${materialPages.materialId} = ${input.materialId}
      and ${materialPages.ownerId} = ${input.ownerId}
      and ${materialPages.confidence} <> 'high')`;
  await db
    .update(materials)
    .set({
      status: sql`case when ${unsure} then 'needs_review' else 'ready' end`,
      updatedAt: input.now,
    })
    .where(
      and(
        liveMaterial(input.ownerId, input.materialId),
        inArray(materials.status, ["ready", "needs_review"]),
      ),
    );
}

/**
 * The teacher's correction of one page of one of their live materials: stored as text_source
 * `manual`, flags cleared, confidence high and reviewed_at set. Text longer than
 * MAX_MANUAL_PAGE_CHARS is refused (`tooLong`), never cut; a page a live OCR job still lists is
 * `busy` (the job would overwrite the correction); a material still being read is `notReady`.
 * Service connection, owner named in every statement.
 */
export async function savePageText(
  tx: MaterialDb,
  input: {
    ownerId: string;
    materialId: string;
    pageNo: number;
    textMd: string;
    now: Date;
  },
): Promise<Result<void, SavePageTextError>> {
  const { ownerId, materialId, pageNo, now } = input;
  if (!UUID.test(materialId) || !Number.isSafeInteger(pageNo) || pageNo < 1) {
    return err("notFound");
  }
  if (input.textMd.length > MAX_MANUAL_PAGE_CHARS) return err("tooLong");
  const material = (
    await tx
      .select({ status: materials.status })
      .from(materials)
      .where(liveMaterial(ownerId, materialId))
      .for("share")
  ).at(0);
  if (!material) return err("notFound");
  if (material.status !== "ready" && material.status !== "needs_review") {
    return err("notReady");
  }
  const page = (
    await tx
      .select({
        status: materialPages.ocrStatus,
        busy: sql<boolean>`${liveJobListsPage}`,
      })
      .from(materialPages)
      .where(
        and(
          eq(materialPages.materialId, materialId),
          eq(materialPages.ownerId, ownerId),
          eq(materialPages.pageNo, pageNo),
        ),
      )
      .for("update")
  ).at(0);
  if (!page) return err("notFound");
  if (page.status === "queued" && page.busy) return err("busy");
  await tx
    .update(materialPages)
    .set({
      textMd: cleanPageText(input.textMd),
      textSource: "manual",
      flags: [],
      confidence: "high",
      reviewedAt: now,
      updatedAt: now,
      // Left queued by a job that ended without it: no longer waiting.
      ...(page.status === "queued" ? { ocrStatus: "failed" } : {}),
    })
    .where(
      and(
        eq(materialPages.materialId, materialId),
        eq(materialPages.ownerId, ownerId),
        eq(materialPages.pageNo, pageNo),
      ),
    );
  await refreshMaterialStatus(tx, { ownerId, materialId, now });
  return ok();
}

export interface ReviewPageSummary {
  pageNo: number;
  confidence: string;
  flags: string[];
  ocrStatus: string;
  textSource: string | null;
}

const flagList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((flag) => typeof flag === "string") : [];

/** Every page of one of the owner's live materials, without text (the review's page list). */
export async function listReviewPages(
  db: MaterialDb,
  input: { ownerId: string; materialId: string },
): Promise<ReviewPageSummary[]> {
  if (!UUID.test(input.materialId)) return [];
  const rows = await db
    .select({
      pageNo: materialPages.pageNo,
      confidence: materialPages.confidence,
      flags: materialPages.flags,
      ocrStatus: shownOcrStatus,
      textSource: materialPages.textSource,
    })
    .from(materialPages)
    .innerJoin(
      materials,
      and(
        eq(materials.id, materialPages.materialId),
        eq(materials.ownerId, materialPages.ownerId),
      ),
    )
    .where(
      and(
        eq(materialPages.materialId, input.materialId),
        eq(materialPages.ownerId, input.ownerId),
        isNull(materials.deletedAt),
      ),
    )
    .orderBy(asc(materialPages.pageNo));
  return rows.map((row) => ({ ...row, flags: flagList(row.flags) }));
}

export interface ReviewPage extends ReviewPageSummary {
  textMd: string;
  reviewedAt: Date | null;
}

/** One page with its text, or null (unknown, foreign or trashed material, no such page). */
export async function getReviewPage(
  db: MaterialDb,
  input: { ownerId: string; materialId: string; pageNo: number },
): Promise<ReviewPage | null> {
  if (!UUID.test(input.materialId) || !Number.isSafeInteger(input.pageNo)) return null;
  const row = (
    await db
      .select({
        pageNo: materialPages.pageNo,
        textMd: materialPages.textMd,
        confidence: materialPages.confidence,
        flags: materialPages.flags,
        ocrStatus: shownOcrStatus,
        textSource: materialPages.textSource,
        reviewedAt: materialPages.reviewedAt,
      })
      .from(materialPages)
      .innerJoin(
        materials,
        and(
          eq(materials.id, materialPages.materialId),
          eq(materials.ownerId, materialPages.ownerId),
        ),
      )
      .where(
        and(
          eq(materialPages.materialId, input.materialId),
          eq(materialPages.ownerId, input.ownerId),
          eq(materialPages.pageNo, input.pageNo),
          isNull(materials.deletedAt),
        ),
      )
      .limit(1)
  ).at(0);
  return row ? { ...row, flags: flagList(row.flags) } : null;
}
