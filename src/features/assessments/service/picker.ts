// What the item picker offers: the owner's bank through the bank's own query (filters, search,
// sort, paging), and the questions banked since a moment (the way back from /generate). Neither
// lists a trashed or unbanked question: both use the bank's `inBank` predicate.
import "server-only";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  notExists,
  sql,
} from "drizzle-orm";
import {
  getBankList,
  inBank,
  stemExcerpt,
  type BankList,
  type BankQuery,
} from "@/features/bank";
import {
  assessmentItems,
  assessments,
  questions,
  questionVersions,
} from "@/lib/db/schema";
import { isUuid, type AssessmentDb } from "./lock";

const SINCE_LIMIT = 20;
const EXCERPT_MAX = 140;

/** Whether the owner has this (not trashed) assessment. */
async function ownsAssessment(
  tx: AssessmentDb,
  ownerId: string,
  assessmentId: string,
): Promise<boolean> {
  if (!isUuid(assessmentId)) return false;
  const rows = await tx
    .select({ id: assessments.id })
    .from(assessments)
    .where(
      and(
        eq(assessments.id, assessmentId),
        eq(assessments.ownerId, ownerId),
        isNull(assessments.deletedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export interface PickerView {
  list: BankList;
  /** Ids on the page that are already in the assessment. */
  added: string[];
  /** Ids on the page whose newer version waits for its check: shown, but not addable yet. */
  pending: string[];
}

/** One page of the bank for the picker, with the ones already in the assessment marked. */
export async function loadPicker(
  tx: AssessmentDb,
  input: { ownerId: string; assessmentId: string; query: BankQuery },
): Promise<PickerView | null> {
  const { ownerId, assessmentId } = input;
  if (!(await ownsAssessment(tx, ownerId, assessmentId))) return null;
  const list = await getBankList(tx, { ownerId, query: input.query });
  const ids = list.items.map((item) => item.questionId);
  const added =
    ids.length === 0
      ? []
      : (
          await tx
            .select({ questionId: assessmentItems.questionId })
            .from(assessmentItems)
            .where(
              and(
                eq(assessmentItems.assessmentId, assessmentId),
                eq(assessmentItems.ownerId, ownerId),
                inArray(assessmentItems.questionId, ids),
              ),
            )
        ).map((row) => row.questionId);
  const pending =
    ids.length === 0
      ? []
      : (
          await tx
            .select({ id: questions.id })
            .from(questions)
            .where(
              and(
                eq(questions.ownerId, ownerId),
                inArray(questions.id, ids),
                sql`${questions.approvedVersionId} is distinct from ${questions.currentVersionId}`,
              ),
            )
        ).map((row) => row.id);
  return { list, added, pending };
}

export interface BankedSinceItem {
  questionId: string;
  stemExcerptMd: string;
  difficulty: "mudah" | "sedang" | "sulit";
}

/**
 * Questions banked at or after `since` that the assessment does not hold yet, newest first (at most
 * 20). The offer after the teacher created questions in /generate for this assessment.
 */
export async function listBankedSince(
  tx: AssessmentDb,
  input: { ownerId: string; assessmentId: string; since: Date },
): Promise<BankedSinceItem[]> {
  const { ownerId, assessmentId } = input;
  if (!(await ownsAssessment(tx, ownerId, assessmentId))) return [];
  const rows = await tx
    .select({
      questionId: questions.id,
      stemMd: questionVersions.stemMd,
      difficulty: questions.difficulty,
    })
    .from(questions)
    .innerJoin(
      questionVersions,
      and(
        eq(questionVersions.id, questions.approvedVersionId),
        eq(questionVersions.ownerId, questions.ownerId),
      ),
    )
    .where(
      and(
        inBank(ownerId),
        isNotNull(questions.bankedAt),
        gte(questions.bankedAt, input.since),
        sql`${questions.approvedVersionId} = ${questions.currentVersionId}`,
        notExists(
          tx
            .select({ one: sql`1` })
            .from(assessmentItems)
            .where(
              and(
                eq(assessmentItems.assessmentId, assessmentId),
                eq(assessmentItems.ownerId, ownerId),
                eq(assessmentItems.questionId, questions.id),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(questions.bankedAt), desc(questions.id))
    .limit(SINCE_LIMIT);
  return rows.map((row) => ({
    questionId: row.questionId,
    stemExcerptMd: stemExcerpt(row.stemMd, EXCERPT_MAX),
    difficulty:
      row.difficulty === "mudah" || row.difficulty === "sulit"
        ? row.difficulty
        : "sedang",
  }));
}
