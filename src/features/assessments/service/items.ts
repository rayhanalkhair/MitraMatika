// The items of an assessment (decisions 2 to 4): add from the bank (pinning the question's current
// version), remove, move and update to the latest version. Every write locks the assessment first
// and is refused while it is approved (lock.ts). The caller applies `runAsUser`; each statement also
// names owner_id.
import "server-only";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { inBank } from "@/features/bank";
import { assessmentItems, assessmentSections, questions } from "@/lib/db/schema";
import { err, ok, type Result } from "@/lib/result";
import { isUuid, lockAssessment, touchAssessment, type AssessmentDb } from "./lock";

export type ItemFailure =
  | "notFound"
  | "approved"
  | "sectionNotFound"
  | "notBanked"
  | "pendingCheck"
  | "tooManyItems"
  | "tooManyAtOnce";

/** A refused question, named: it left the bank, or its newer version waits for its check. */
export interface QuestionRefusal {
  code: "notBanked" | "pendingCheck";
  questionId: string;
}

/** The most questions one assessment holds, and the most ids one add may carry. */
export const MAX_ITEMS = 200;
export const MAX_ADD_PER_CALL = 50;

async function sectionBelongs(
  tx: AssessmentDb,
  input: { ownerId: string; assessmentId: string; sectionId: string },
): Promise<boolean> {
  if (!isUuid(input.sectionId)) return false;
  const rows = await tx
    .select({ id: assessmentSections.id })
    .from(assessmentSections)
    .where(
      and(
        eq(assessmentSections.id, input.sectionId),
        eq(assessmentSections.assessmentId, input.assessmentId),
        eq(assessmentSections.ownerId, input.ownerId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** The item ids of a section in order. */
async function sectionItemIds(
  tx: AssessmentDb,
  input: { ownerId: string; sectionId: string },
): Promise<string[]> {
  const rows = await tx
    .select({ id: assessmentItems.id })
    .from(assessmentItems)
    .where(
      and(
        eq(assessmentItems.sectionId, input.sectionId),
        eq(assessmentItems.ownerId, input.ownerId),
      ),
    )
    .orderBy(asc(assessmentItems.sortOrder), asc(assessmentItems.id));
  return rows.map((row) => row.id);
}

/**
 * Puts exactly these items, in this order, into the section: dense sort_order from 0, in one
 * statement (an item that is already in place is rewritten with the same values).
 */
export async function writeSectionOrder(
  tx: AssessmentDb,
  input: { ownerId: string; sectionId: string; itemIds: string[] },
): Promise<void> {
  if (input.itemIds.length === 0) return;
  const rows = sql.join(
    input.itemIds.map((id, index) => sql`(${id}::uuid, ${index}::int)`),
    sql`, `,
  );
  await tx.execute(sql`
    update assessment_items as i
    set section_id = ${input.sectionId}::uuid, sort_order = v.position, updated_at = now()
    from (values ${rows}) as v(id, position)
    where i.id = v.id and i.owner_id = ${input.ownerId}::uuid
  `);
}

/**
 * Adds the questions at the end of the section, in the given order, each pinned to its current
 * version. A question already in the assessment (in any section) is skipped, as is a repeated id.
 * One question that is not in the bank (unbanked, trashed, a draft, foreign, unknown, or waiting for
 * a new check) refuses the whole call: nothing is added.
 */
export async function addItems(
  tx: AssessmentDb,
  input: {
    ownerId: string;
    assessmentId: string;
    sectionId: string;
    questionIds: string[];
  },
): Promise<Result<{ added: number; skipped: number }, ItemFailure | QuestionRefusal>> {
  const { ownerId, assessmentId, sectionId } = input;
  if (input.questionIds.length > MAX_ADD_PER_CALL) return err("tooManyAtOnce");
  const locked = await lockAssessment(tx, { ownerId, assessmentId });
  if (!locked.ok) return locked;
  if (!(await sectionBelongs(tx, { ownerId, assessmentId, sectionId }))) {
    return err("sectionNotFound");
  }
  const wanted = [...new Set(input.questionIds)];
  if (wanted.some((id) => !isUuid(id))) return err("notBanked");
  if (wanted.length === 0) return ok({ added: 0, skipped: input.questionIds.length });

  const present = new Set(
    (
      await tx
        .select({ questionId: assessmentItems.questionId })
        .from(assessmentItems)
        .where(
          and(
            eq(assessmentItems.assessmentId, assessmentId),
            eq(assessmentItems.ownerId, ownerId),
            inArray(assessmentItems.questionId, wanted),
          ),
        )
    ).map((row) => row.questionId),
  );
  const toAdd = wanted.filter((id) => !present.has(id));
  if (toAdd.length > 0) {
    // In the bank (what the picker lists), with the version to pin and the approved one.
    const inBankRows = await tx
      .select({
        id: questions.id,
        versionId: questions.currentVersionId,
        approvedVersionId: questions.approvedVersionId,
      })
      .from(questions)
      .where(and(inBank(ownerId), inArray(questions.id, toAdd)));
    const known = new Map(inBankRows.map((row) => [row.id, row]));
    for (const questionId of toAdd) {
      const row = known.get(questionId);
      if (!row) return err({ code: "notBanked", questionId });
      if (row.versionId === null || row.versionId !== row.approvedVersionId) {
        return err({ code: "pendingCheck", questionId });
      }
    }
    const versionOf = new Map(inBankRows.map((row) => [row.id, row.versionId]));

    const held = (
      await tx
        .select({ n: count() })
        .from(assessmentItems)
        .where(
          and(
            eq(assessmentItems.assessmentId, assessmentId),
            eq(assessmentItems.ownerId, ownerId),
          ),
        )
    ).at(0)?.n;
    if ((held ?? 0) + toAdd.length > MAX_ITEMS) return err("tooManyItems");

    const last = (
      await tx
        .select({ n: sql<number | null>`max(${assessmentItems.sortOrder})` })
        .from(assessmentItems)
        .where(
          and(
            eq(assessmentItems.sectionId, sectionId),
            eq(assessmentItems.ownerId, ownerId),
          ),
        )
    ).at(0)?.n;
    const start = last === null || last === undefined ? 0 : last + 1;
    await tx.insert(assessmentItems).values(
      toAdd.map((questionId, index) => ({
        ownerId,
        assessmentId,
        sectionId,
        questionId,
        questionVersionId: versionOf.get(questionId) ?? "",
        sortOrder: start + index,
      })),
    );
    await touchAssessment(tx, { ownerId, assessmentId });
  }
  return ok({ added: toAdd.length, skipped: input.questionIds.length - toAdd.length });
}

interface ItemRef {
  id: string;
  assessmentId: string;
  sectionId: string;
  questionId: string;
  questionVersionId: string;
}

const itemRef = async (
  tx: AssessmentDb,
  ownerId: string,
  itemId: string,
): Promise<ItemRef | null> => {
  if (!isUuid(itemId)) return null;
  return (
    (
      await tx
        .select({
          id: assessmentItems.id,
          assessmentId: assessmentItems.assessmentId,
          sectionId: assessmentItems.sectionId,
          questionId: assessmentItems.questionId,
          questionVersionId: assessmentItems.questionVersionId,
        })
        .from(assessmentItems)
        .where(and(eq(assessmentItems.id, itemId), eq(assessmentItems.ownerId, ownerId)))
        .limit(1)
    ).at(0) ?? null
  );
};

/**
 * Finds the item, locks its assessment, and reads the item again under the lock (it may have been
 * removed meanwhile). `approved` and `notFound` come back as the failure.
 */
async function lockItem(
  tx: AssessmentDb,
  input: { ownerId: string; itemId: string },
): Promise<Result<ItemRef, "notFound" | "approved">> {
  const first = await itemRef(tx, input.ownerId, input.itemId);
  if (!first) return err("notFound");
  const locked = await lockAssessment(tx, {
    ownerId: input.ownerId,
    assessmentId: first.assessmentId,
  });
  if (!locked.ok) return locked;
  const item = await itemRef(tx, input.ownerId, input.itemId);
  return item ? ok(item) : err("notFound");
}

/** Removes the item and closes the gap in its section. */
export async function removeItem(
  tx: AssessmentDb,
  input: { ownerId: string; itemId: string },
): Promise<Result<void, "notFound" | "approved">> {
  const { ownerId } = input;
  const item = await lockItem(tx, input);
  if (!item.ok) return item;
  await tx
    .delete(assessmentItems)
    .where(
      and(eq(assessmentItems.id, item.data.id), eq(assessmentItems.ownerId, ownerId)),
    );
  const rest = await sectionItemIds(tx, { ownerId, sectionId: item.data.sectionId });
  await writeSectionOrder(tx, { ownerId, sectionId: item.data.sectionId, itemIds: rest });
  await touchAssessment(tx, { ownerId, assessmentId: item.data.assessmentId });
  return ok();
}

/**
 * Moves the item to a place in a section of the same assessment (the index counts from 0 and is
 * clamped to the section's ends) and renumbers the sections it touches densely.
 */
export async function moveItem(
  tx: AssessmentDb,
  input: { ownerId: string; itemId: string; toSectionId: string; toIndex: number },
): Promise<Result<void, ItemFailure>> {
  const { ownerId } = input;
  const found = await lockItem(tx, input);
  if (!found.ok) return found;
  const item = found.data;
  if (
    !(await sectionBelongs(tx, {
      ownerId,
      assessmentId: item.assessmentId,
      sectionId: input.toSectionId,
    }))
  ) {
    return err("sectionNotFound");
  }
  const target = (
    await sectionItemIds(tx, { ownerId, sectionId: input.toSectionId })
  ).filter((id) => id !== item.id);
  const index = Math.min(Math.max(Math.trunc(input.toIndex) || 0, 0), target.length);
  target.splice(index, 0, item.id);
  await writeSectionOrder(tx, { ownerId, sectionId: input.toSectionId, itemIds: target });
  if (item.sectionId !== input.toSectionId) {
    const source = await sectionItemIds(tx, { ownerId, sectionId: item.sectionId });
    await writeSectionOrder(tx, { ownerId, sectionId: item.sectionId, itemIds: source });
  }
  await touchAssessment(tx, { ownerId, assessmentId: item.assessmentId });
  return ok();
}

/**
 * Moves the item's pin to the question's current version. Only while the question is in the bank
 * (not trashed, not unbanked, no new version awaiting its check): else `notBanked`.
 */
export async function updateItemToLatest(
  tx: AssessmentDb,
  input: { ownerId: string; itemId: string },
): Promise<Result<{ changed: boolean }, ItemFailure>> {
  const { ownerId } = input;
  const found = await lockItem(tx, input);
  if (!found.ok) return found;
  const item = found.data;
  const question = (
    await tx
      .select({
        currentVersionId: questions.currentVersionId,
        approvedVersionId: questions.approvedVersionId,
      })
      .from(questions)
      .where(and(eq(questions.id, item.questionId), inBank(ownerId)))
      .limit(1)
  ).at(0);
  if (!question?.currentVersionId) return err("notBanked");
  // A newer version that waits for its check is not offered yet.
  if (question.currentVersionId !== question.approvedVersionId) {
    return err("pendingCheck");
  }
  if (question.currentVersionId === item.questionVersionId) return ok({ changed: false });
  await tx
    .update(assessmentItems)
    .set({ questionVersionId: question.currentVersionId, updatedAt: sql`now()` })
    .where(and(eq(assessmentItems.id, item.id), eq(assessmentItems.ownerId, ownerId)));
  await touchAssessment(tx, { ownerId, assessmentId: item.assessmentId });
  return ok({ changed: true });
}
