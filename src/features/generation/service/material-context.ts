import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { learningObjectives, materialPages, topics } from "@/lib/db/schema";
import type { MaterialSelection } from "../schema/material-selection";
import { citationExcerpt, stripMarkers } from "./citations";
import { resolveMaterialSelection } from "./material-selection";
import type { AnyDb } from "./persist";

// The most material text one prompt carries (plan decision 8).
export const MATERIAL_CONTEXT_TOKENS = 3_500;
// One page never takes more than this, so a long page cannot crowd out every other one.
const MAX_PASSAGE_TOKENS = 1_200;
// A remainder smaller than this is not worth a passage.
const MIN_PASSAGE_TOKENS = 60;
// Full-text rank plus half the trigram word similarity to the topic.
const TRIGRAM_WEIGHT = 0.5;
// The relevance floor: a page matches the topic when a stemmed topic word occurs on it
// (ts_rank > 0) or the topic title nearly occurs on it (word similarity at least this).
export const MIN_TITLE_SIMILARITY = 0.6;

/** The gateway's own estimate (TokenBudget.estimate): about 3.5 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/** One page as the prompt carries it, with what a citation of it stores. */
export interface MaterialPassage {
  // `P<page>`: the id the model cites.
  id: string;
  page: number;
  // The page text made safe for the data block (markers, control characters and block
  // delimiters removed), cut to the passage's share of the budget.
  text: string;
  pageId: string;
  sectionId: string | null;
  // At most 300 characters of the page text without markers (question_sources.excerpt).
  excerpt: string;
}

export interface MaterialContext {
  passages: MaterialPassage[];
  // The estimated tokens of the passage texts (the prompt adds a short header per passage).
  tokens: number;
  // Set when the selection is usable but no page in it matches the topic: questions written
  // from it would not be grounded in the material, so the caller refuses.
  unrelated?: true;
}

/**
 * Untrusted page text for the prompt's data block: no control characters but newlines, no run of
 * `<` or `>` (the block delimiters are `<<<MATERI` and `MATERI>>>`), no `[P<n>]` that could pose
 * as another passage's header, and no `[[?]]` markers (R14).
 */
export function cleanPassageText(text: string): string {
  return stripMarkers(text)
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ")
    .replace(/[<>]{3,}/g, "")
    .replace(/\[\s*(P\d+)\s*\]/gi, "($1)")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// What the pages are ranked against: the topic's title, scope notes and learning objectives.
async function topicQuery(
  db: AnyDb,
  topicId: string,
): Promise<{ text: string; title: string }> {
  const topic = (
    await db
      .select({ title: topics.title, scopeNotes: topics.scopeNotes })
      .from(topics)
      .where(eq(topics.id, topicId))
      .limit(1)
  ).at(0);
  if (!topic) return { text: "", title: "" };
  const objectives = await db
    .select({ text: learningObjectives.text })
    .from(learningObjectives)
    .where(eq(learningObjectives.topicId, topicId))
    .orderBy(asc(learningObjectives.code));
  return {
    title: topic.title,
    text: [topic.title, topic.scopeNotes, ...objectives.map((row) => row.text)]
      .join(" ")
      .slice(0, 2_000),
  };
}

/**
 * The passages a material-mode prompt carries: only pages the selection allows (re-checked for
 * the owner: a material trashed or a page re-queued since the request gives nothing), ranked by
 * full-text relevance (`ts_rank`, Indonesian configuration, any query word) plus trigram word
 * similarity to the topic, and taken best first while they fit in `maxTokens` (3,500 by
 * default). The passages come back in page order. An unusable selection gives no passages.
 */
export async function buildMaterialContext(
  db: AnyDb,
  input: {
    ownerId: string;
    materialId: string;
    selection: MaterialSelection;
    topicId: string;
    maxTokens?: number;
  },
): Promise<MaterialContext> {
  const empty: MaterialContext = { passages: [], tokens: 0 };
  if (input.selection.materialId !== input.materialId) return empty;
  const resolved = await resolveMaterialSelection(db, {
    ownerId: input.ownerId,
    selection: input.selection,
  });
  if (!resolved.ok) return empty;
  const budget = Math.min(
    input.maxTokens ?? MATERIAL_CONTEXT_TOKENS,
    MATERIAL_CONTEXT_TOKENS,
  );

  const query = await topicQuery(db, input.topicId);
  // Any word of the topic counts (plainto_tsquery would require all of them).
  const tsQuery = sql`to_tsquery('indonesian', replace(plainto_tsquery('indonesian', ${query.text})::text, ' & ', ' | '))`;
  const ranked = await db
    .select({
      id: materialPages.id,
      // Drivers differ on float8 (number or string): read as either.
      rank: sql<number | string>`ts_rank(${materialPages.tsv}, ${tsQuery})::float8`,
      similarity: sql<
        number | string
      >`word_similarity(${query.title}, ${materialPages.textMd})::float8`,
    })
    .from(materialPages)
    .where(
      and(
        eq(materialPages.ownerId, input.ownerId),
        eq(materialPages.materialId, resolved.data.materialId),
        inArray(
          materialPages.id,
          resolved.data.pages.map((page) => page.id),
        ),
      ),
    );
  // Without topic text there is nothing to judge relevance by: rank only.
  const matches = ranked.some(
    (row) => Number(row.rank) > 0 || Number(row.similarity) >= MIN_TITLE_SIMILARITY,
  );
  if (query.text.trim().length > 0 && !matches) return { ...empty, unrelated: true };
  const score = new Map(
    ranked.map((row) => [
      row.id,
      Number(row.rank) + TRIGRAM_WEIGHT * Number(row.similarity),
    ]),
  );
  const order = [...resolved.data.pages].sort(
    (a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0) || a.pageNo - b.pageNo,
  );

  const passages: MaterialPassage[] = [];
  let tokens = 0;
  for (const page of order) {
    const room = Math.min(budget - tokens, MAX_PASSAGE_TOKENS);
    if (room < MIN_PASSAGE_TOKENS) break;
    let text = cleanPassageText(page.textMd);
    if (text.length === 0) continue;
    if (estimateTokens(text) > room)
      text = text.slice(0, Math.floor(room * 3.5)).trimEnd();
    const cost = estimateTokens(text);
    passages.push({
      id: `P${String(page.pageNo)}`,
      page: page.pageNo,
      text,
      pageId: page.id,
      sectionId: page.sectionId,
      excerpt: citationExcerpt(page.textMd),
    });
    tokens += cost;
  }
  passages.sort((a, b) => a.page - b.page);
  return { passages, tokens };
}
