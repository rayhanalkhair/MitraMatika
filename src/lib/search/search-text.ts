// The text the bank search runs on: lower case, no accents, no LaTeX commands. Shared by every
// path that creates or changes a question's current version, and by the backfill, so the stored
// `questions.search_text` and a normalised query always speak the same alphabet.

/** Lower case, accents stripped, LaTeX commands and math delimiters removed, spaces collapsed. */
export function normaliseSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\\[a-z]+/g, " ")
    .replace(/[$\\{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface SearchTextInput {
  stemMd: string;
  // The stored jsonb: [{ label, text_md }]. Anything else contributes nothing.
  options: unknown;
  explanationMd: string;
  // The learning objective (TP) codes of the question's topic.
  objectiveCodes: readonly string[];
}

function optionTexts(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((option: unknown) => {
    const text = (option as { text_md?: unknown } | null)?.text_md;
    return typeof text === "string" ? [text] : [];
  });
}

/** Stem + options + explanation + TP codes of a version, normalised. */
export function buildSearchText(input: SearchTextInput): string {
  return normaliseSearch(
    [
      input.stemMd,
      ...optionTexts(input.options),
      input.explanationMd,
      ...input.objectiveCodes,
    ].join(" "),
  );
}
