// How far a page's extracted text can be trusted (decision 4 of the materials plan). Simple,
// documented heuristics over character classes; nothing here calls a model.
//
// - low_text: fewer than MIN_TEXT_CHARS letters and digits on the page. A scanned page has no
//   text layer at all, or only a page number or a running header (a handful of characters). A short
//   page that reads well (a title and a sentence, 15 letters or more) is NOT flagged: being short
//   is not a quality problem (smoke test S-07).
// - garbled: in a page with at least MIN_GARBLED_SAMPLE visible characters, more than
//   MAX_BAD_RATIO of them are replacement, control, private-use or unassigned characters (a font
//   without a usable Unicode map), or fewer than MIN_WORD_RATIO of them are letters, marks or digits
//   (a font whose map points at the wrong glyphs and yields punctuation soup).
// - uncertain_math: the page contains the uncertainty marker `[[?]]` (put there by OCR or the DOCX
//   reader around text they are not sure of).
// - formula_text: MIN_MATH_SYMBOLS or more maths symbols (Unicode category Sm: + = < > − × ÷ ≤
//   √ ...) outside delimited LaTeX. A PDF text layer does not keep a formula's reading order
//   (extraction spike, result 2), so a page dense with formulas may be scrambled even when every
//   character is right. A few simple equations (two or three lines such as "x + y = 5") carry up
//   to five symbols and read in order, so they pass: the threshold was 3, which sent clean SPLDV
//   pages to review (smoke test S-07). LaTeX between `$` or `$$` (DOCX equations converted from
//   OMML) is structured already and is not counted, for garbled either.
//
// Confidence: low when low_text or garbled; medium when only uncertain_math or formula_text; high
// otherwise.

export type PageConfidence = "high" | "medium" | "low";
/** `truncated` is set by ingestion, never by pageQuality: the document went on past this page. */
export type PageFlag =
  "uncertain_math" | "formula_text" | "low_text" | "garbled" | "truncated";
export interface PageQuality {
  confidence: PageConfidence;
  flags: PageFlag[];
}

export const MIN_TEXT_CHARS = 15;
export const MIN_GARBLED_SAMPLE = 20;
export const MAX_BAD_RATIO = 0.02;
export const MIN_WORD_RATIO = 0.5;
export const MIN_MATH_SYMBOLS = 6;
/** The marker OCR and the DOCX reader put around text they are not sure of. */
export const UNCERTAIN_MARK = "[[?]]";
/** The longest text kept for one page (a hostile file cannot make one page's row huge). */
export const MAX_PAGE_CHARS = 20_000;

const LATEX = /\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g;
const TEXT_CHAR = /[\p{L}\p{N}]/gu;
const WORD_CHAR = /[\p{L}\p{M}\p{N}]/gu;
// Replacement character, controls other than tab and newlines, private use, unassigned.
const BAD_CHAR = /[\ufffd\p{Co}\p{Cn}]|[^\P{Cc}\t\n\r]/gu;
const VISIBLE = /\S/gu;
const MATH_SYMBOL = /\p{Sm}/gu;

const countOf = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

export function pageQuality(text: string): PageQuality {
  const prose = text.replace(LATEX, " ");
  const flags: PageFlag[] = [];

  if (text.includes(UNCERTAIN_MARK)) flags.push("uncertain_math");
  if (countOf(prose, MATH_SYMBOL) >= MIN_MATH_SYMBOLS) flags.push("formula_text");
  if (countOf(text, TEXT_CHAR) < MIN_TEXT_CHARS) flags.push("low_text");
  const visible = countOf(prose, VISIBLE);
  if (
    visible >= MIN_GARBLED_SAMPLE &&
    (countOf(prose, BAD_CHAR) / visible > MAX_BAD_RATIO ||
      countOf(prose, WORD_CHAR) / visible < MIN_WORD_RATIO)
  ) {
    flags.push("garbled");
  }

  const confidence: PageConfidence =
    flags.includes("low_text") || flags.includes("garbled")
      ? "low"
      : flags.includes("uncertain_math") || flags.includes("formula_text")
        ? "medium"
        : "high";
  return { confidence, flags };
}

/**
 * Text as it may be stored: NUL and unpaired surrogates (which Postgres text refuses) become the
 * replacement character, line ends become `\n`, the ends are trimmed and the page is cut at
 * MAX_PAGE_CHARS.
 */
export function cleanPageText(text: string): string {
  return text
    .replace(
      /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
      "\ufffd",
    )
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, MAX_PAGE_CHARS)
    .replace(/[\ud800-\udbff]$/, "");
}
