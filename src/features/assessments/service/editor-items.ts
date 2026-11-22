// The items of an assessment resolved to what the editor shows: the PINNED version's content plus
// the state of the question now. Nothing here reads the machine answer or the verification detail.
import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { assessmentItems, questions, questionVersions } from "@/lib/db/schema";
import type { AssessmentDb } from "./lock";

export type ItemState = "ok" | "trashed" | "unbanked" | "pending";

export interface EditorItem {
  itemId: string;
  sectionId: string;
  questionId: string;
  versionId: string;
  versionNo: number;
  points: number;
  difficulty: "mudah" | "sedang" | "sulit";
  stemMd: string;
  options: { label: "A" | "B" | "C" | "D"; textMd: string }[];
  correctLabel: "A" | "B" | "C" | "D" | null;
  /**
   * `trashed`: the question is in the trash. `unbanked`: it left the bank. `pending`: it is in the
   * bank but its newer version waits for its check.
   */
  state: ItemState;
  /** The question's current version differs from the pinned one. */
  newerVersionAvailable: boolean;
  /** The teacher may move the item to the current version (newer, and the question is in the bank). */
  canUpdate: boolean;
}

export interface EditorSection {
  id: string;
  title: string;
  items: EditorItem[];
}

const label = z.enum(["A", "B", "C", "D"]);
const contentSchema = z.object({
  options: z.array(z.object({ label, text_md: z.string() })),
  answer: z.object({ correctLabel: label }),
});
const DIFFICULTIES = ["mudah", "sedang", "sulit"] as const;

/** All items of one assessment, section by section in order. */
export async function loadItems(
  tx: AssessmentDb,
  input: { ownerId: string; assessmentId: string },
): Promise<EditorItem[]> {
  const rows = await tx
    .select({
      itemId: assessmentItems.id,
      sectionId: assessmentItems.sectionId,
      questionId: assessmentItems.questionId,
      versionId: assessmentItems.questionVersionId,
      points: assessmentItems.points,
      versionNo: questionVersions.versionNo,
      stemMd: questionVersions.stemMd,
      options: questionVersions.options,
      answer: questionVersions.answer,
      difficulty: questionVersions.difficulty,
      status: questions.status,
      bankedAt: questions.bankedAt,
      deletedAt: questions.deletedAt,
      approvedVersionId: questions.approvedVersionId,
      currentVersionId: questions.currentVersionId,
    })
    .from(assessmentItems)
    .innerJoin(
      questionVersions,
      and(
        eq(questionVersions.id, assessmentItems.questionVersionId),
        eq(questionVersions.ownerId, assessmentItems.ownerId),
      ),
    )
    .innerJoin(
      questions,
      and(
        eq(questions.id, assessmentItems.questionId),
        eq(questions.ownerId, assessmentItems.ownerId),
      ),
    )
    .where(
      and(
        eq(assessmentItems.assessmentId, input.assessmentId),
        eq(assessmentItems.ownerId, input.ownerId),
      ),
    )
    .orderBy(asc(assessmentItems.sortOrder), asc(assessmentItems.id));

  return rows.map((row): EditorItem => {
    const parsed = contentSchema.safeParse({ options: row.options, answer: row.answer });
    const banked =
      row.status === "approved" &&
      row.bankedAt !== null &&
      row.approvedVersionId !== null;
    const state: ItemState =
      row.deletedAt !== null
        ? "trashed"
        : !banked
          ? "unbanked"
          : row.approvedVersionId === row.currentVersionId
            ? "ok"
            : "pending";
    const newer = row.currentVersionId !== null && row.currentVersionId !== row.versionId;
    return {
      itemId: row.itemId,
      sectionId: row.sectionId,
      questionId: row.questionId,
      versionId: row.versionId,
      versionNo: row.versionNo,
      points: Number(row.points),
      difficulty: DIFFICULTIES.find((value) => value === row.difficulty) ?? "sedang",
      stemMd: row.stemMd,
      options: parsed.success
        ? parsed.data.options.map((o) => ({ label: o.label, textMd: o.text_md }))
        : [],
      correctLabel: parsed.success ? parsed.data.answer.correctLabel : null,
      state,
      newerVersionAvailable: newer,
      canUpdate: newer && state === "ok",
    };
  });
}
