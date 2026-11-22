// The trash for questions (MAT-09 applied to questions): moving a question to the trash, bringing
// it back, deleting it for good, and the trash list. The `authenticated` role may not write
// deleted_at, so the writes run on the service connection (R9) and every statement names owner_id;
// the list runs under runAsUser and names owner_id as well.
import { and, asc, count, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  assessmentItems,
  assessments,
  questions,
  questionVersions,
  topics,
} from "@/lib/db/schema";
import type { AnyDb } from "@/features/generation";
import { stemExcerpt } from "@/features/bank";
import { err, ok, type Result } from "@/lib/result";
import {
  cancelPendingRegeneration,
  isInUse,
  purgeQuestion,
  type PurgeCounts,
} from "./purge";
import { daysLeft, purgeAfterFrom, type InUse, type TrashFailure } from "./retention";

export { daysLeft, TRASH_RETENTION_DAYS } from "./retention";
export type { InUse, TrashFailure } from "./retention";

const EXCERPT_MAX = 140;

/**
 * Moves one of the owner's questions to the trash: deleted_at now, purge_after now + 30 days, and
 * its pending regenerations cancelled. Nothing else changes, so a restore gives it back as it was.
 * Unknown, foreign or already trashed ids are notFound.
 */
export async function trashQuestion(
  db: AnyDb,
  input: { ownerId: string; questionId: string; now: Date },
): Promise<Result<void, TrashFailure>> {
  const { ownerId, questionId, now } = input;
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(questions)
      .set({
        deletedAt: now,
        purgeAfter: purgeAfterFrom(now),
      })
      .where(
        and(
          eq(questions.id, questionId),
          eq(questions.ownerId, ownerId),
          isNull(questions.deletedAt),
        ),
      )
      .returning({ id: questions.id });
    if (updated.length === 0) return err("notFound");
    await cancelPendingRegeneration(tx, { ownerId, questionId, now });
    return ok();
  });
}

/** Whether the owner has this question at all (to tell notFound from notInTrash). */
async function ownsQuestion(db: AnyDb, ownerId: string, questionId: string) {
  const row = (
    await db
      .select({ id: questions.id })
      .from(questions)
      .where(and(eq(questions.id, questionId), eq(questions.ownerId, ownerId)))
      .limit(1)
  ).at(0);
  return row !== undefined;
}

/**
 * Takes a question out of the trash, unchanged: approval, bank state and versions are what they
 * were. One guarded UPDATE: a purge that already removed the row leaves nothing to restore, and a
 * purge waiting on the row lock re-checks deleted_at and skips it.
 */
export async function restoreQuestion(
  db: AnyDb,
  input: { ownerId: string; questionId: string },
): Promise<Result<void, TrashFailure>> {
  const { ownerId, questionId } = input;
  const updated = await db
    .update(questions)
    .set({ deletedAt: null, purgeAfter: null })
    .where(
      and(
        eq(questions.id, questionId),
        eq(questions.ownerId, ownerId),
        isNotNull(questions.deletedAt),
      ),
    )
    .returning({ id: questions.id });
  if (updated.length > 0) return ok();
  return err((await ownsQuestion(db, ownerId, questionId)) ? "notInTrash" : "notFound");
}

/**
 * Deletes a trashed question for good, now: the question, every version, their verification runs
 * and curriculum sources, logged in deletion_log with ids and counts only. A question that is not
 * in the trash is refused (notInTrash); one an assessment pins is refused with the titles of the
 * assessments (`inUse`, R2).
 */
export async function deletePermanently(
  db: AnyDb,
  input: { ownerId: string; questionId: string; now: Date },
): Promise<Result<PurgeCounts, TrashFailure | InUse>> {
  const { ownerId, questionId, now } = input;
  const outcome = await purgeQuestion(db, { questionId, ownerId, now });
  if (outcome) return isInUse(outcome) ? err(outcome) : ok(outcome);
  return err((await ownsQuestion(db, ownerId, questionId)) ? "notInTrash" : "notFound");
}

export interface TrashItem {
  questionId: string;
  topicTitle: string;
  stemExcerptMd: string;
  versionCount: number;
  deletedAt: string;
  purgeAfter: string;
  /** Whole days until the purge, never below 0 (0 = goes at the next daily purge). */
  daysLeft: number;
  /** Titles of the assessments that pin it: it stays in the trash as long as they exist (R2). */
  pinnedBy: string[];
}

/** The owner's trash, most recently deleted first. */
export async function listTrash(
  db: AnyDb,
  input: { ownerId: string; now: Date },
): Promise<TrashItem[]> {
  const { ownerId, now } = input;
  const rows = await db
    .select({
      questionId: questions.id,
      topicTitle: topics.title,
      stemMd: questionVersions.stemMd,
      deletedAt: questions.deletedAt,
      purgeAfter: questions.purgeAfter,
    })
    .from(questions)
    .innerJoin(
      questionVersions,
      and(
        eq(questionVersions.id, questions.currentVersionId),
        eq(questionVersions.ownerId, questions.ownerId),
      ),
    )
    .innerJoin(topics, eq(topics.id, questions.topicId))
    .where(and(eq(questions.ownerId, ownerId), isNotNull(questions.deletedAt)))
    .orderBy(desc(questions.deletedAt), asc(questions.id));
  if (rows.length === 0) return [];

  const versionCounts = await db
    .select({ questionId: questionVersions.questionId, n: count() })
    .from(questionVersions)
    .where(
      and(
        eq(questionVersions.ownerId, ownerId),
        inArray(
          questionVersions.questionId,
          rows.map((row) => row.questionId),
        ),
      ),
    )
    .groupBy(questionVersions.questionId);

  const pins = await db
    .selectDistinct({
      questionId: assessmentItems.questionId,
      title: assessments.title,
    })
    .from(assessmentItems)
    .innerJoin(
      assessments,
      and(
        eq(assessments.id, assessmentItems.assessmentId),
        eq(assessments.ownerId, assessmentItems.ownerId),
      ),
    )
    .where(
      and(
        eq(assessmentItems.ownerId, ownerId),
        inArray(
          assessmentItems.questionId,
          rows.map((row) => row.questionId),
        ),
      ),
    )
    .orderBy(asc(assessments.title));

  return rows.flatMap((row) => {
    if (!row.deletedAt || !row.purgeAfter) return [];
    return [
      {
        questionId: row.questionId,
        topicTitle: row.topicTitle,
        stemExcerptMd: stemExcerpt(row.stemMd, EXCERPT_MAX),
        versionCount: versionCounts.find((c) => c.questionId === row.questionId)?.n ?? 1,
        deletedAt: row.deletedAt.toISOString(),
        purgeAfter: row.purgeAfter.toISOString(),
        daysLeft: daysLeft(row.purgeAfter, now),
        pinnedBy: pins
          .filter((pin) => pin.questionId === row.questionId)
          .map((pin) => pin.title),
      },
    ];
  });
}
