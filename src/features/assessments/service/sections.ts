// The sections of an assessment (decision 2): add, rename and remove. Removing a section moves its
// items to the previous one. Every write locks the assessment first and is refused while approved.
import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { assessmentItems, assessmentSections } from "@/lib/db/schema";
import { err, ok, type Result } from "@/lib/result";
import { writeSectionOrder } from "./items";
import { isUuid, lockAssessment, touchAssessment, type AssessmentDb } from "./lock";

export const MAX_SECTIONS = 10;

export type SectionFailure = "notFound" | "approved";

async function ordered(
  tx: AssessmentDb,
  ownerId: string,
  assessmentId: string,
): Promise<{ id: string }[]> {
  return tx
    .select({ id: assessmentSections.id })
    .from(assessmentSections)
    .where(
      and(
        eq(assessmentSections.assessmentId, assessmentId),
        eq(assessmentSections.ownerId, ownerId),
      ),
    )
    .orderBy(asc(assessmentSections.sortOrder), asc(assessmentSections.id));
}

/** Adds a section at the end. */
export async function addSection(
  tx: AssessmentDb,
  input: { ownerId: string; assessmentId: string; title: string },
): Promise<Result<{ id: string }, SectionFailure | "tooMany">> {
  const { ownerId, assessmentId } = input;
  const locked = await lockAssessment(tx, { ownerId, assessmentId });
  if (!locked.ok) return locked;
  const existing = await ordered(tx, ownerId, assessmentId);
  if (existing.length >= MAX_SECTIONS) return err("tooMany");
  const created = (
    await tx
      .insert(assessmentSections)
      .values({ ownerId, assessmentId, title: input.title, sortOrder: existing.length })
      .returning({ id: assessmentSections.id })
  ).at(0);
  if (!created) throw new Error("section insert returned no row");
  await touchAssessment(tx, { ownerId, assessmentId });
  return ok({ id: created.id });
}

async function sectionAssessment(
  tx: AssessmentDb,
  ownerId: string,
  sectionId: string,
): Promise<string | null> {
  if (!isUuid(sectionId)) return null;
  const row = (
    await tx
      .select({ assessmentId: assessmentSections.assessmentId })
      .from(assessmentSections)
      .where(
        and(
          eq(assessmentSections.id, sectionId),
          eq(assessmentSections.ownerId, ownerId),
        ),
      )
      .limit(1)
  ).at(0);
  return row?.assessmentId ?? null;
}

/** Renames the section. */
export async function renameSection(
  tx: AssessmentDb,
  input: { ownerId: string; sectionId: string; title: string },
): Promise<Result<void, SectionFailure>> {
  const { ownerId, sectionId } = input;
  const assessmentId = await sectionAssessment(tx, ownerId, sectionId);
  if (!assessmentId) return err("notFound");
  const locked = await lockAssessment(tx, { ownerId, assessmentId });
  if (!locked.ok) return locked;
  const updated = await tx
    .update(assessmentSections)
    .set({ title: input.title, updatedAt: sql`now()` })
    .where(
      and(eq(assessmentSections.id, sectionId), eq(assessmentSections.ownerId, ownerId)),
    )
    .returning({ id: assessmentSections.id });
  if (updated.length === 0) return err("notFound");
  await touchAssessment(tx, { ownerId, assessmentId });
  return ok();
}

/**
 * Removes the section. Its items move to the end of the previous section (to the start of the next
 * one when it is the first). The last section of an assessment cannot be removed.
 */
export async function removeSection(
  tx: AssessmentDb,
  input: { ownerId: string; sectionId: string },
): Promise<Result<void, SectionFailure | "lastSection">> {
  const { ownerId, sectionId } = input;
  const assessmentId = await sectionAssessment(tx, ownerId, sectionId);
  if (!assessmentId) return err("notFound");
  const locked = await lockAssessment(tx, { ownerId, assessmentId });
  if (!locked.ok) return locked;
  const all = await ordered(tx, ownerId, assessmentId);
  const index = all.findIndex((row) => row.id === sectionId);
  if (index === -1) return err("notFound");
  if (all.length === 1) return err("lastSection");

  const idsOf = async (id: string) =>
    (
      await tx
        .select({ id: assessmentItems.id })
        .from(assessmentItems)
        .where(
          and(eq(assessmentItems.sectionId, id), eq(assessmentItems.ownerId, ownerId)),
        )
        .orderBy(asc(assessmentItems.sortOrder), asc(assessmentItems.id))
    ).map((row) => row.id);
  const moving = await idsOf(sectionId);
  if (moving.length > 0) {
    const previous: { id: string } | undefined = index > 0 ? all[index - 1] : undefined;
    const heir = previous ?? all[index + 1];
    const own = await idsOf(heir.id);
    await writeSectionOrder(tx, {
      ownerId,
      sectionId: heir.id,
      itemIds: previous ? [...own, ...moving] : [...moving, ...own],
    });
  }
  await tx
    .delete(assessmentSections)
    .where(
      and(eq(assessmentSections.id, sectionId), eq(assessmentSections.ownerId, ownerId)),
    );
  const rest = all.filter((row) => row.id !== sectionId);
  if (rest.length > 0) {
    const rows = sql.join(
      rest.map((row, order) => sql`(${row.id}::uuid, ${order}::int)`),
      sql`, `,
    );
    await tx.execute(sql`
      update assessment_sections as s
      set sort_order = v.position, updated_at = now()
      from (values ${rows}) as v(id, position)
      where s.id = v.id and s.owner_id = ${ownerId}::uuid
    `);
  }
  await touchAssessment(tx, { ownerId, assessmentId });
  return ok();
}
