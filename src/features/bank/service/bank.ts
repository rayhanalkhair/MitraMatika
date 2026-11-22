// Saving to the Bank Soal. The caller applies `runAsUser`, so the statement also runs under RLS;
// it names owner_id as well because the service connection does not enforce RLS.
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { cpElements, questions, questionVersions, topics } from "@/lib/db/schema";
import { normaliseSearch } from "@/lib/search/search-text";
import { BANK_PAGE_SIZE, type BankQuery } from "../schema/bank-query";
import type { AnyDb } from "@/features/generation";
import {
  loadVersionContent,
  projectCurriculum,
  projectReviewQuestion,
  toReviewStatus,
  type RequestReview,
  type ReviewQuestion,
} from "@/features/review";
import { buildTraces, toDbStatus } from "@/features/generation";

/**
 * One guarded UPDATE: only approved, still-current, not yet banked questions of this request that
 * are not in the trash.
 * A question regenerated after approval (approved_version_id <> current_version_id) is skipped,
 * and a second call finds nothing left to save.
 */
export async function bankApprovedQuestions(
  db: AnyDb,
  input: { ownerId: string; requestId: string; now: Date },
): Promise<{ saved: number }> {
  const updated = await db
    .update(questions)
    .set({
      bankedAt: input.now,
      rowVersion: sql`${questions.rowVersion} + 1`,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(questions.ownerId, input.ownerId),
        eq(questions.generationRequestId, input.requestId),
        eq(questions.status, "approved"),
        sql`${questions.approvedVersionId} = ${questions.currentVersionId}`,
        isNull(questions.bankedAt),
        isNull(questions.deletedAt),
      ),
    )
    .returning({ id: questions.id });
  return { saved: updated.length };
}

export interface BankListItem {
  questionId: string;
  topicTitle: string;
  objectiveCode: string | null;
  difficulty: ReviewQuestion["difficulty"];
  type: "multiple_choice";
  status: ReviewQuestion["verification"]["status"];
  stemExcerptMd: string;
  versionNo: number;
  bankedAt: string;
}

export interface BankList {
  items: BankListItem[];
  total: number;
  page: number;
  pageCount: number;
  // The owner's whole bank, not narrowed by the filters: what the filter controls can offer.
  facets: {
    grades: number[];
    elements: { id: string; name: string }[];
    topics: { id: string; title: string }[];
  };
}

export interface BankQuestion {
  question: ReviewQuestion;
  curriculum: RequestReview["curriculum"];
  bankedAt: string;
}

const EXCERPT_MAX = 140;
const DIFFICULTIES = ["mudah", "sedang", "sulit"] as const;

// In the bank: saved, still approved, not in the trash. The bank shows the APPROVED version: while
// a regeneration of a banked question waits for its checks, the current version is newer and the
// bank keeps showing the approved one (R10 revised, R19).
export const inBank = (ownerId: string) =>
  and(
    eq(questions.ownerId, ownerId),
    eq(questions.status, "approved"),
    isNotNull(questions.bankedAt),
    isNull(questions.deletedAt),
    isNotNull(questions.approvedVersionId),
  );

// Walks the unescaped math delimiters (`$` inline, `$$` display) of `text`. Reports where a span is
// still open at the end, and where the first span closes (null when it never does).
function scanMath(text: string): { openAt: number | null; firstEnd: number | null } {
  let open: { at: number; display: boolean } | null = null;
  let firstEnd: number | null = null;
  for (const match of text.matchAll(/(?<!\\)\$\$?/g)) {
    const display = match[0] === "$$";
    if (open === null) {
      open = { at: match.index, display };
    } else if (open.display === display) {
      firstEnd ??= match.index + match[0].length;
      open = null;
    } else if (!display) {
      // A single `$` inside a display span is plain text for our purposes.
    } else {
      // `$$` inside an inline span: the first `$` closes it, the second opens a new one.
      firstEnd ??= match.index + 1;
      open = { at: match.index + 1, display: false };
    }
  }
  return { openAt: open?.at ?? null, firstEnd };
}

// First `max` characters, cut at the last whitespace, never leaving a half-open `$...` or `$$...$$`
// span and never only the ellipsis for a non-empty stem.
export function stemExcerpt(md: string, max: number): string {
  if (md.length <= max) return md;
  let cut = md.slice(0, max);
  if (!/\s/.test(md.charAt(max))) {
    const lastSpace = cut.search(/\s\S*$/);
    if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  }
  cut = cut.trimEnd();
  const { openAt } = scanMath(cut);
  if (openAt !== null) cut = cut.slice(0, openAt).trimEnd();
  if (cut.length > 0) return `${cut}…`;

  // The stem opens with math that does not fit: keep that first span whole (never cut inside it).
  const { firstEnd } = scanMath(md);
  if (firstEnd !== null) return `${md.slice(0, firstEnd)}…`;
  // Math that never closes: plain text only.
  return `${md.slice(0, max).replace(/\$/g, "").trim()}…`;
}

// The number of questions in the bank, as one aggregate: the list is capped, this is not.
export async function getBankCount(
  db: AnyDb,
  input: { ownerId: string },
): Promise<number> {
  const row = (
    await db.select({ n: count() }).from(questions).where(inBank(input.ownerId))
  ).at(0);
  return row?.n ?? 0;
}

// The status the reader sees: the latest real verification run of the approved version (a
// regeneration marker is history, not a run), else the version's own column; stored spelling.
const effectiveStatus = sql<string>`coalesce((
  select vr.status from verification_runs vr
  where vr.question_version_id = ${questionVersions.id}
    and vr.owner_id = ${questions.ownerId}
    and not coalesce(jsonb_exists(vr.cross_check, 'regeneration'), false)
  order by vr.created_at desc, vr.id desc limit 1
), ${questionVersions.verificationStatus})`;

const difficultyRank = sql`case ${questions.difficulty} when 'mudah' then 1 when 'sedang' then 2 else 3 end`;

// Jakarta has no daylight saving: a plain date is its midnight at +07:00.
function jakartaDay(date: string, plusDays = 0): Date | null {
  const start = new Date(`${date}T00:00:00+07:00`);
  if (Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() + plusDays * 24 * 60 * 60 * 1000);
}

// Search words are plain text: LIKE wildcards in them are matched literally (backslash escapes).
const escapeLike = (text: string) => text.replace(/[\\%_]/g, "\\$&");

// A query made only of words of 4 or more letters also tolerates a misspelling (trigram word
// similarity). Anything with a digit, a hyphen or a short word (a TP code such as tp-3) matches
// literally only: trigram similarity would match every TP code of the bank.
const isFuzzy = (search: string) =>
  search.split(" ").every((word) => /^[a-z]{4,}$/.test(word));

function bankFilters(query: BankQuery, search: string): SQL[] {
  const filters: SQL[] = [];
  if (query.grade !== undefined) filters.push(eq(questions.grade, query.grade));
  if (query.topicId) filters.push(eq(questions.topicId, query.topicId));
  if (query.elementId) filters.push(eq(topics.cpElementId, query.elementId));
  if (query.difficulty) filters.push(eq(questions.difficulty, query.difficulty));
  if (query.type) filters.push(eq(questions.type, query.type));
  if (query.origin) filters.push(eq(questions.origin, query.origin));
  if (query.status) filters.push(sql`${effectiveStatus} = ${toDbStatus(query.status)}`);
  const from = query.from ? jakartaDay(query.from) : null;
  if (from) filters.push(gte(questions.bankedAt, from));
  const until = query.to ? jakartaDay(query.to, 1) : null;
  if (until) filters.push(lt(questions.bankedAt, until));
  if (search) {
    const like = ilike(questions.searchText, `%${escapeLike(search)}%`);
    const match = isFuzzy(search)
      ? or(like, sql`${search} <% ${questions.searchText}`)
      : like;
    if (match) filters.push(match);
  }
  return filters;
}

function bankOrder(query: BankQuery, search: string): SQL[] {
  const order: SQL[] = [];
  if (query.sort === "oldest") order.push(asc(questions.bankedAt));
  else if (query.sort === "difficulty") {
    order.push(asc(difficultyRank), desc(questions.bankedAt));
  } else order.push(desc(questions.bankedAt));
  // The chosen sort always wins; similarity only orders rows the sort leaves tied.
  if (search !== "" && isFuzzy(search)) {
    order.push(sql`word_similarity(${search}, ${questions.searchText}) desc`);
  }
  order.push(asc(questions.id));
  return order;
}

// The bank list: banked questions of the owner, filtered, searched, sorted and cut to one page of
// 20. A fixed number of statements whatever the number of rows: the count, the rows, three facet
// reads, then the set-based trace build.
export async function getBankList(
  db: AnyDb,
  input: { ownerId: string; query: BankQuery },
): Promise<BankList> {
  const { ownerId, query } = input;
  const search = query.q ? normaliseSearch(query.q) : "";
  const where = and(inBank(ownerId), ...bankFilters(query, search));

  const total =
    (
      await db
        .select({ n: count() })
        .from(questions)
        .innerJoin(
          questionVersions,
          and(
            eq(questionVersions.id, questions.approvedVersionId),
            eq(questionVersions.ownerId, questions.ownerId),
          ),
        )
        .innerJoin(topics, eq(topics.id, questions.topicId))
        .where(where)
    ).at(0)?.n ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / BANK_PAGE_SIZE));
  const page = Math.min(query.page, pageCount);

  const rows = await db
    .select({
      id: questions.id,
      topicId: questions.topicId,
      versionId: questionVersions.id,
      versionNo: questionVersions.versionNo,
      difficulty: questions.difficulty,
      stemMd: questionVersions.stemMd,
      bankedAt: questions.bankedAt,
    })
    .from(questions)
    .innerJoin(
      questionVersions,
      and(
        eq(questionVersions.id, questions.approvedVersionId),
        eq(questionVersions.ownerId, questions.ownerId),
      ),
    )
    .innerJoin(topics, eq(topics.id, questions.topicId))
    .where(where)
    .orderBy(...bankOrder(query, search))
    .limit(BANK_PAGE_SIZE)
    .offset((page - 1) * BANK_PAGE_SIZE);

  const whole = inBank(ownerId);
  const grades = await db
    .selectDistinct({ grade: questions.grade })
    .from(questions)
    .where(whole)
    .orderBy(asc(questions.grade));
  const topicFacets = await db
    .selectDistinct({ id: topics.id, title: topics.title })
    .from(questions)
    .innerJoin(topics, eq(topics.id, questions.topicId))
    .where(whole)
    .orderBy(asc(topics.title), asc(topics.id));
  const elementFacets = await db
    .selectDistinct({ id: cpElements.id, name: cpElements.name })
    .from(questions)
    .innerJoin(topics, eq(topics.id, questions.topicId))
    .innerJoin(cpElements, eq(cpElements.id, topics.cpElementId))
    .where(whole)
    .orderBy(asc(cpElements.name), asc(cpElements.id));

  const traces = await buildTraces(
    db,
    ownerId,
    rows.map((row) => ({
      questionId: row.id,
      versionId: row.versionId,
      topicId: row.topicId,
    })),
  );
  const items: BankListItem[] = [];
  for (const row of rows) {
    const trace = traces.find((candidate) => candidate.versionId === row.versionId);
    if (!trace || !row.bankedAt) continue;
    items.push({
      questionId: row.id,
      topicTitle: trace.curriculum?.topicTitle ?? "",
      objectiveCode: trace.curriculum?.objectives[0]?.code ?? null,
      difficulty: (DIFFICULTIES as readonly string[]).includes(row.difficulty)
        ? (row.difficulty as ReviewQuestion["difficulty"])
        : "sedang",
      type: "multiple_choice",
      status: toReviewStatus(trace.verification.status),
      stemExcerptMd: stemExcerpt(row.stemMd, EXCERPT_MAX),
      versionNo: row.versionNo,
      bankedAt: row.bankedAt.toISOString(),
    });
  }
  return {
    items,
    total,
    page,
    pageCount,
    facets: {
      grades: grades.map((row) => row.grade),
      elements: elementFacets,
      topics: topicFacets,
    },
  };
}

/**
 * One banked question: the approved version (equal to the current one by the predicate), through the
 * same content projection as the review. Null for unknown, foreign, unbanked, rejected or stale ids.
 */
export async function getBankQuestion(
  db: AnyDb,
  input: { ownerId: string; questionId: string },
): Promise<BankQuestion | null> {
  const row = (
    await db
      .select({
        versionId: questions.approvedVersionId,
        topicId: questions.topicId,
        bankedAt: questions.bankedAt,
      })
      .from(questions)
      .innerJoin(
        questionVersions,
        and(
          eq(questionVersions.id, questions.approvedVersionId),
          eq(questionVersions.ownerId, questions.ownerId),
        ),
      )
      .where(and(eq(questions.id, input.questionId), inBank(input.ownerId)))
      .limit(1)
  ).at(0);
  if (!row?.versionId || !row.bankedAt) return null;

  const trace = (
    await buildTraces(db, input.ownerId, [
      { questionId: input.questionId, versionId: row.versionId, topicId: row.topicId },
    ])
  ).at(0);
  if (!trace) return null;
  const [content] = await loadVersionContent(db, input.ownerId, [row.versionId]);
  const question = projectReviewQuestion(trace, content);
  if (!question) return null;
  return {
    question,
    curriculum: projectCurriculum(trace),
    bankedAt: row.bankedAt.toISOString(),
  };
}
