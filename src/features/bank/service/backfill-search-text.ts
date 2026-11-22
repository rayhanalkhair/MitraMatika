import { and, asc, eq, gt, inArray, isNotNull } from "drizzle-orm";
import { learningObjectives, questions, questionVersions } from "@/lib/db/schema";
import type { AnyDb } from "@/features/generation";
import { buildSearchText } from "@/lib/search/search-text";

export const BACKFILL_BATCH_SIZE = 200;
const EMPTY_MARK = " ";

/**
 * Fills `questions.search_text` for rows that still have the empty default (questions that
 * existed before the column), from their current version. Service connection: it spans owners
 * and relies on the explicit key joins below, not on RLS. Idempotent: it only touches rows whose
 * search text is empty, and every write repeats that condition. Pages by id so a row that stays
 * empty (no current version) cannot make it loop; text that normalises to nothing is stored as a
 * single space so it is not scanned again.
 * Returns how many rows it filled; `maxBatches` bounds one call.
 */
export async function backfillSearchText(
  db: AnyDb,
  options: {
    batchSize?: number;
    maxBatches?: number;
    /** Checked before each batch: when true, no new batch starts. */
    outOfTime?: () => boolean;
    /** Called when `outOfTime` stopped the backfill. */
    onOutOfTime?: () => void;
  } = {},
): Promise<number> {
  const batchSize = options.batchSize ?? BACKFILL_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;
  let filled = 0;
  let lastId: string | null = null;

  for (let batch = 0; batch < maxBatches; batch++) {
    if (options.outOfTime?.()) {
      options.onOutOfTime?.();
      break;
    }
    const rows = await db
      .select({
        id: questions.id,
        topicId: questions.topicId,
        stemMd: questionVersions.stemMd,
        options: questionVersions.options,
        explanationMd: questionVersions.explanationMd,
      })
      .from(questions)
      .innerJoin(
        questionVersions,
        and(
          eq(questionVersions.id, questions.currentVersionId),
          eq(questionVersions.ownerId, questions.ownerId),
        ),
      )
      .where(
        and(
          eq(questions.searchText, ""),
          isNotNull(questions.currentVersionId),
          lastId === null ? undefined : gt(questions.id, lastId),
        ),
      )
      .orderBy(asc(questions.id))
      .limit(batchSize);
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1].id;

    const topicIds = [...new Set(rows.map((row) => row.topicId))];
    const objectives = await db
      .select({ topicId: learningObjectives.topicId, code: learningObjectives.code })
      .from(learningObjectives)
      .where(inArray(learningObjectives.topicId, topicIds))
      .orderBy(asc(learningObjectives.code));

    for (const row of rows) {
      const text = buildSearchText({
        stemMd: row.stemMd,
        options: row.options,
        explanationMd: row.explanationMd,
        objectiveCodes: objectives
          .filter((o) => o.topicId === row.topicId)
          .map((o) => o.code),
      });
      // Text that normalises to nothing is marked with a single space: it is no longer empty, so
      // the next run does not read it again, and no normalised query can match it.
      const stored = text === "" ? EMPTY_MARK : text;
      const updated = await db
        .update(questions)
        .set({ searchText: stored })
        .where(and(eq(questions.id, row.id), eq(questions.searchText, "")))
        .returning({ id: questions.id });
      filled += updated.length;
    }
    if (rows.length < batchSize) break;
  }
  return filled;
}
