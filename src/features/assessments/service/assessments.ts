// Assessments (decision 1): create, update with an optimistic lock, the list and the editor read
// model. The caller applies `runAsUser`, so every statement also runs under RLS (Ruling R1); each
// one names owner_id as well. A trashed assessment (deleted_at set) is invisible here.
import "server-only";
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  assessmentItems,
  assessments,
  assessmentSections,
  schoolTemplates,
} from "@/lib/db/schema";
import { err, ok, type Result } from "@/lib/result";
import { DEFAULT_SECTION_TITLE, type AssessmentInput } from "../schema/assessment";
import { loadItems, type EditorSection } from "./editor-items";
import { isUuid, lockAssessment, type AssessmentDb } from "./lock";
import { SCORING_MODES, type ScoringMode } from "./scoring";

export type { AssessmentDb } from "./lock";

type Row = typeof assessments.$inferSelect;

/** A template the teacher may use: theirs and not in the trash. */
async function templateUsable(
  tx: AssessmentDb,
  ownerId: string,
  templateId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: schoolTemplates.id })
    .from(schoolTemplates)
    .where(
      and(
        eq(schoolTemplates.id, templateId),
        eq(schoolTemplates.ownerId, ownerId),
        isNull(schoolTemplates.deletedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function defaultTemplateId(
  tx: AssessmentDb,
  ownerId: string,
): Promise<string | null> {
  const row = (
    await tx
      .select({ id: schoolTemplates.id })
      .from(schoolTemplates)
      .where(
        and(
          eq(schoolTemplates.ownerId, ownerId),
          eq(schoolTemplates.isDefault, true),
          isNull(schoolTemplates.deletedAt),
        ),
      )
      .limit(1)
  ).at(0);
  return row?.id ?? null;
}

const columns = (input: AssessmentInput) => ({
  title: input.title,
  kind: input.kind,
  grade: input.grade,
  templateId: input.templateId,
  examDate: input.examDate,
  durationMinutes: input.durationMinutes,
  instructionsMd: input.instructions,
});

/**
 * A new draft with its first section "A. Pilihan ganda". Without a template it takes the teacher's
 * default one (if any); a template that is not theirs, or is trashed, is `templateNotFound`.
 */
export async function createAssessment(
  tx: AssessmentDb,
  input: { ownerId: string; input: AssessmentInput },
): Promise<Result<{ id: string; sectionId: string }, "templateNotFound">> {
  const { ownerId } = input;
  let templateId = input.input.templateId;
  if (templateId === null) {
    templateId = await defaultTemplateId(tx, ownerId);
  } else if (!(await templateUsable(tx, ownerId, templateId))) {
    return err("templateNotFound");
  }
  const created = (
    await tx
      .insert(assessments)
      .values({ ...columns(input.input), templateId, ownerId })
      .returning({ id: assessments.id })
  ).at(0);
  if (!created) throw new Error("assessment insert returned no row");
  const section = (
    await tx
      .insert(assessmentSections)
      .values({
        ownerId,
        assessmentId: created.id,
        title: DEFAULT_SECTION_TITLE,
        sortOrder: 0,
      })
      .returning({ id: assessmentSections.id })
  ).at(0);
  if (!section) throw new Error("section insert returned no row");
  return ok({ id: created.id, sectionId: section.id });
}

export type UpdateFailure = "notFound" | "conflict" | "approved" | "templateNotFound";

/**
 * Updates the fields. The teacher names the row version they saw (optimistic lock): a stale one is
 * `conflict`. The row is locked first and an approved assessment is refused until it is reopened.
 */
export async function updateAssessment(
  tx: AssessmentDb,
  input: {
    ownerId: string;
    assessmentId: string;
    input: AssessmentInput;
    expectedRowVersion: number;
  },
): Promise<Result<{ rowVersion: number }, UpdateFailure>> {
  const { ownerId, assessmentId } = input;
  const locked = await lockAssessment(tx, { ownerId, assessmentId });
  if (!locked.ok) return locked;
  if (locked.data.rowVersion !== input.expectedRowVersion) return err("conflict");
  const { templateId } = input.input;
  if (templateId !== null && !(await templateUsable(tx, ownerId, templateId))) {
    return err("templateNotFound");
  }
  const updated = (
    await tx
      .update(assessments)
      .set({
        ...columns(input.input),
        rowVersion: sql`${assessments.rowVersion} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(assessments.id, assessmentId),
          eq(assessments.ownerId, ownerId),
          eq(assessments.rowVersion, input.expectedRowVersion),
        ),
      )
      .returning({ rowVersion: assessments.rowVersion })
  ).at(0);
  return updated ? ok({ rowVersion: updated.rowVersion }) : err("conflict");
}

export interface AssessmentListItem {
  id: string;
  title: string;
  kind: AssessmentInput["kind"];
  grade: number;
  status: "draft" | "approved";
  examDate: string | null;
  itemCount: number;
  sectionCount: number;
  updatedAt: string;
}

/** The owner's assessments, most recently changed first, trashed ones left out. */
export async function listAssessments(
  tx: AssessmentDb,
  ownerId: string,
): Promise<AssessmentListItem[]> {
  const rows = await tx
    .select()
    .from(assessments)
    .where(and(eq(assessments.ownerId, ownerId), isNull(assessments.deletedAt)))
    .orderBy(
      desc(assessments.updatedAt),
      desc(assessments.createdAt),
      asc(assessments.id),
    );
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const itemCounts = await tx
    .select({ id: assessmentItems.assessmentId, n: count() })
    .from(assessmentItems)
    .where(
      and(
        eq(assessmentItems.ownerId, ownerId),
        inArray(assessmentItems.assessmentId, ids),
      ),
    )
    .groupBy(assessmentItems.assessmentId);
  const sectionCounts = await tx
    .select({ id: assessmentSections.assessmentId, n: count() })
    .from(assessmentSections)
    .where(
      and(
        eq(assessmentSections.ownerId, ownerId),
        inArray(assessmentSections.assessmentId, ids),
      ),
    )
    .groupBy(assessmentSections.assessmentId);
  const itemsBy = new Map(itemCounts.map((row) => [row.id, row.n]));
  const sectionsBy = new Map(sectionCounts.map((row) => [row.id, row.n]));
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    kind: row.kind as AssessmentInput["kind"],
    grade: row.grade,
    status: row.status === "approved" ? "approved" : "draft",
    examDate: row.examDate,
    itemCount: itemsBy.get(row.id) ?? 0,
    sectionCount: sectionsBy.get(row.id) ?? 0,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export interface AssessmentEditorView {
  assessment: {
    id: string;
    title: string;
    kind: AssessmentInput["kind"];
    grade: number;
    templateId: string | null;
    examDate: string | null;
    durationMinutes: number | null;
    instructions: string | null;
    status: "draft" | "approved";
    rowVersion: number;
    scoringMode: ScoringMode;
    /** A shuffle seed is stored: the documents print the items shuffled within each section. */
    shuffled: boolean;
  };
  sections: EditorSection[];
}

const toAssessment = (row: Row): AssessmentEditorView["assessment"] => ({
  id: row.id,
  title: row.title,
  kind: row.kind as AssessmentInput["kind"],
  grade: row.grade,
  templateId: row.templateId,
  examDate: row.examDate,
  durationMinutes: row.durationMinutes,
  instructions: row.instructionsMd,
  status: row.status === "approved" ? "approved" : "draft",
  rowVersion: row.rowVersion,
  scoringMode: SCORING_MODES.find((mode) => mode === row.scoringMode) ?? "equal",
  shuffled: row.shuffleSeed !== null,
});

/**
 * The editor: the assessment with its sections in order, each with its items resolved to the
 * pinned version's content and flagged when a newer version exists or the question left the bank.
 * Null for unknown, foreign, trashed and malformed ids.
 */
export async function getAssessmentEditor(
  tx: AssessmentDb,
  input: { ownerId: string; assessmentId: string },
): Promise<AssessmentEditorView | null> {
  const { ownerId, assessmentId } = input;
  if (!isUuid(assessmentId)) return null;
  const row = (
    await tx
      .select()
      .from(assessments)
      .where(
        and(
          eq(assessments.id, assessmentId),
          eq(assessments.ownerId, ownerId),
          isNull(assessments.deletedAt),
        ),
      )
      .limit(1)
  ).at(0);
  if (!row) return null;
  const sectionRows = await tx
    .select()
    .from(assessmentSections)
    .where(
      and(
        eq(assessmentSections.assessmentId, assessmentId),
        eq(assessmentSections.ownerId, ownerId),
      ),
    )
    .orderBy(asc(assessmentSections.sortOrder), asc(assessmentSections.id));
  const items = await loadItems(tx, { ownerId, assessmentId });
  return {
    assessment: toAssessment(row),
    sections: sectionRows.map((section) => ({
      id: section.id,
      title: section.title,
      items: items.filter((item) => item.sectionId === section.id),
    })),
  };
}
