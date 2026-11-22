import { err, ok, type Result } from "@/lib/result";

/** One passage a material question cites: its id in the prompt (`P<page>`) and the page. */
export interface Citation {
  passageId: string;
  page: number;
}

// At most this much of the cited page is stored with the citation (question_sources.excerpt).
export const MAX_EXCERPT_CHARS = 300;

// The marker OCR and DOCX conversion put around uncertain text (ruling R14).
const MARKER = /\[\[\?\]\]/g;

/** The page text without the `[[?]]` uncertainty markers (the text between them is kept). */
export function stripMarkers(text: string): string {
  return text.replace(MARKER, "");
}

/** The stored excerpt of a cited page: markers removed, whitespace collapsed, 300 chars at most. */
export function citationExcerpt(text: string): string {
  return stripMarkers(text)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_EXCERPT_CHARS)
    .trim();
}

// "P3", "[P3]" or " p3 " name passage P3; anything else names no passage.
const CITATION_ID = /^\[?\s*P(\d{1,4})\s*\]?$/i;

function normalise(raw: string): string | null {
  const match = CITATION_ID.exec(raw.trim());
  return match ? `P${String(Number(match[1]))}` : null;
}

/**
 * The citations of one generated question, checked against the passage ids its prompt carried.
 * Any id that was not provided (an invented `[P99]`, a page outside the selection, free text) or a
 * question that cites nothing is `unknownCitation`: the caller regenerates it once, then marks it
 * unverifiable. Duplicates collapse; the order of first mention is kept.
 */
export function validateCitations(
  question: { citations?: readonly string[] },
  passageIds: readonly string[],
): Result<Citation[], "unknownCitation"> {
  const provided = new Set(passageIds);
  const cited: Citation[] = [];
  for (const raw of question.citations ?? []) {
    const id = normalise(raw);
    if (id === null || !provided.has(id)) return err("unknownCitation");
    if (!cited.some((citation) => citation.passageId === id)) {
      cited.push({ passageId: id, page: Number(id.slice(1)) });
    }
  }
  return cited.length > 0 ? ok(cited) : err("unknownCitation");
}
