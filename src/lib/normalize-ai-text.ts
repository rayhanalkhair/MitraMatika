// Models sometimes write the two characters backslash and n (or \r\n, \t) where they mean a line
// break, usually between display formulas: step 2 of a solved equation then printed
// `2x = 11 - 3`, the text \n, `2x = 8` (smoke finding S-10). These helpers turn such sequences
// OUTSIDE maths into real line breaks (a tab becomes a space). Inside `$...$` and `$$...$$` nothing
// changes, so LaTeX commands that start with n (\neq, \nu, \nabla, \natural, \not, \newline) stay
// intact. The maths regions are found with the same rule as `splitMath` (block first, then inline
// on one line, `\$` is never a delimiter).
//
// `normalizeAiText` runs when an AI answer is accepted (the zod schemas); `unescapeLiteralBreaks`
// is what `splitMath` applies to its text segments, so text stored before the fix is also shown
// right.

/** `\\n`, `\\r\\n` or `\\t` (a backslash that is itself escaped is not an escape). */
const ESCAPES = /(?<!\\)(?:\\r\\n|\\n|\\t)/g;

const MATH_OR_ESCAPE = /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)|(?<!\\)(?:\\r\\n|\\n|\\t)/g;

// Private-use placeholder that hides an escaped dollar while the maths regions are matched.
const ESCAPED_DOLLAR = "";

const replacement = (escape: string): string => (escape === "\\t" ? " " : "\n");

/** The escapes of one stretch of text that holds no maths. */
export function unescapeLiteralBreaks(text: string): string {
  return text.includes("\\") ? text.replace(ESCAPES, replacement) : text;
}

/** The escapes of a whole text, leaving the contents of `$...$` and `$$...$$` as they are. */
export function normalizeAiText(text: string): string {
  if (!text.includes("\\")) return text;
  const guarded = text.replace(/\\\$/g, ESCAPED_DOLLAR);
  const converted = guarded.replace(MATH_OR_ESCAPE, (match, math: string | undefined) =>
    math === undefined ? replacement(match) : match,
  );
  return converted.replaceAll(ESCAPED_DOLLAR, "\\$");
}
