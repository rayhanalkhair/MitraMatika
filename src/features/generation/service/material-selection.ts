import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { materialPages, materials, materialSections } from "@/lib/db/schema";
import { err, ok, type Result } from "@/lib/result";
import type { MaterialSelection } from "../schema/material-selection";
import type { AnyDb } from "./persist";

/**
 * Why a selection cannot be used: `material` (unknown, another teacher's or in the trash),
 * `notReady` (ingestion not finished or failed), `sections` (a chapter not of this material),
 * `pages` (a chosen page that does not exist, has no text yet or is waiting for OCR), `empty`
 * (the document or chapters hold no readable page).
 */
export type MaterialSelectionError =
  "material" | "notReady" | "sections" | "pages" | "empty";

export interface SelectedPage {
  id: string;
  pageNo: number;
  textMd: string;
  // The narrowest chapter or section the page belongs to (a chosen one first), if any.
  sectionId: string | null;
}

export interface ResolvedSelection {
  materialId: string;
  title: string;
  pages: SelectedPage[];
}

// Ingestion is done (the teacher may still be reviewing flagged pages).
const READABLE_STATUSES = new Set(["ready", "needs_review"]);

interface SectionRange {
  id: string;
  start: number;
  end: number;
}

// The narrowest range holding the page; ties go to the one starting later (a sub-section).
function sectionOf(pageNo: number, ranges: SectionRange[]): string | null {
  let best: SectionRange | null = null;
  for (const range of ranges) {
    if (pageNo < range.start || pageNo > range.end) continue;
    if (
      best === null ||
      range.end - range.start < best.end - best.start ||
      (range.end - range.start === best.end - best.start && range.start > best.start)
    ) {
      best = range;
    }
  }
  return best?.id ?? null;
}

const readable = (page: { textMd: string; ocrStatus: string }) =>
  page.ocrStatus !== "queued" && page.textMd.trim().length > 0;

/**
 * Checks a material selection for its owner and lists the pages it allows, in page order. Every
 * statement names the owner (the service connection does not enforce RLS); a trashed or foreign
 * material is `material`, the same answer as an unknown id.
 */
export async function resolveMaterialSelection(
  db: AnyDb,
  input: { ownerId: string; selection: MaterialSelection },
): Promise<Result<ResolvedSelection, MaterialSelectionError>> {
  const { ownerId, selection } = input;
  const material = (
    await db
      .select({
        id: materials.id,
        title: materials.title,
        status: materials.status,
        pageCount: materials.pageCount,
      })
      .from(materials)
      .where(
        and(
          eq(materials.id, selection.materialId),
          eq(materials.ownerId, ownerId),
          isNull(materials.deletedAt),
        ),
      )
      .limit(1)
  ).at(0);
  if (!material) return err("material");
  if (!READABLE_STATUSES.has(material.status)) return err("notReady");

  const pages = await db
    .select({
      id: materialPages.id,
      pageNo: materialPages.pageNo,
      textMd: materialPages.textMd,
      ocrStatus: materialPages.ocrStatus,
    })
    .from(materialPages)
    .where(
      and(eq(materialPages.materialId, material.id), eq(materialPages.ownerId, ownerId)),
    )
    .orderBy(asc(materialPages.pageNo));
  const lastPage = Math.max(material.pageCount ?? 0, pages.at(-1)?.pageNo ?? 0);

  const sections: SectionRange[] = (
    await db
      .select({
        id: materialSections.id,
        pageStart: materialSections.pageStart,
        pageEnd: materialSections.pageEnd,
      })
      .from(materialSections)
      .where(
        and(
          eq(materialSections.materialId, material.id),
          eq(materialSections.ownerId, ownerId),
        ),
      )
  ).map((row) => ({
    id: row.id,
    start: row.pageStart,
    // A chapter without an end runs to the end of the material.
    end: row.pageEnd ?? lastPage,
  }));

  let allowed: typeof pages;
  let chosen: SectionRange[] = [];
  if (selection.scope === "pages") {
    const wanted = [...new Set(selection.pages)].sort((a, b) => a - b);
    allowed = [];
    for (const pageNo of wanted) {
      const page = pages.find((candidate) => candidate.pageNo === pageNo);
      if (!page || !readable(page)) return err("pages");
      allowed.push(page);
    }
  } else if (selection.scope === "sections") {
    const ids = new Set(selection.sectionIds);
    chosen = sections.filter((section) => ids.has(section.id));
    if (chosen.length !== ids.size) return err("sections");
    allowed = pages.filter(
      (page) =>
        readable(page) &&
        chosen.some(
          (section) => page.pageNo >= section.start && page.pageNo <= section.end,
        ),
    );
  } else {
    allowed = pages.filter(readable);
  }
  if (allowed.length === 0) return err("empty");

  return ok({
    materialId: material.id,
    title: material.title,
    pages: allowed.map((page) => ({
      id: page.id,
      pageNo: page.pageNo,
      textMd: page.textMd,
      sectionId: sectionOf(page.pageNo, chosen) ?? sectionOf(page.pageNo, sections),
    })),
  });
}

/** A material the teacher may generate from, with its confirmed chapters (the source picker). */
export interface GenerationMaterial {
  id: string;
  title: string;
  pageCount: number | null;
  sections: { id: string; title: string; pageStart: number; pageEnd: number | null }[];
}

// The picker lists at most this many materials, newest first.
export const GENERATION_MATERIALS_LIMIT = 100;

/**
 * The owner's materials whose ingestion is done (ready or needs review), not in the trash, newest
 * first (at most 100; `truncated` when there are more), with their chapters in page order.
 * Every statement names the owner; it also runs under RLS (runAsUser) from the page.
 */
export async function listGenerationMaterials(
  db: AnyDb,
  ownerId: string,
): Promise<{ materials: GenerationMaterial[]; truncated: boolean }> {
  const found = await db
    .select({ id: materials.id, title: materials.title, pageCount: materials.pageCount })
    .from(materials)
    .where(
      and(
        eq(materials.ownerId, ownerId),
        isNull(materials.deletedAt),
        inArray(materials.status, [...READABLE_STATUSES]),
      ),
    )
    .orderBy(desc(materials.createdAt), asc(materials.id))
    .limit(GENERATION_MATERIALS_LIMIT + 1);
  const truncated = found.length > GENERATION_MATERIALS_LIMIT;
  const rows = found.slice(0, GENERATION_MATERIALS_LIMIT);
  if (rows.length === 0) return { materials: [], truncated };
  const sections = await db
    .select({
      id: materialSections.id,
      materialId: materialSections.materialId,
      title: materialSections.title,
      pageStart: materialSections.pageStart,
      pageEnd: materialSections.pageEnd,
    })
    .from(materialSections)
    .where(
      and(
        eq(materialSections.ownerId, ownerId),
        inArray(
          materialSections.materialId,
          rows.map((row) => row.id),
        ),
      ),
    )
    .orderBy(asc(materialSections.pageStart), asc(materialSections.title));
  return {
    materials: rows.map((row) => ({
      ...row,
      sections: sections
        .filter((section) => section.materialId === row.id)
        .map(({ id, title, pageStart, pageEnd }) => ({ id, title, pageStart, pageEnd })),
    })),
    truncated,
  };
}
