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

/**
 * A literal escape (a backslash that is itself escaped is not one): `\r\n`, `\n` or `\t`, with the
 * letters that follow it. When `\n` or `\t` plus those letters spell a LaTeX command (`\neq`,
 * `\nu`, `\text`, `\times`), the model wrote bare LaTeX without delimiters and it is not an escape
 * either; `\nLangkah` and `\nuntuk` are not commands and are escapes.
 */
const ESCAPE_SOURCE = String.raw`(?<!\\)\\(?:r\\n|([nt]))([A-Za-z]*)`;

const LATEX_COMMANDS = new Set(
  (
    "neq ne nu nabla natural not notin neg ni nmid ncong nsim nless ngtr nleq ngeq nleqslant " +
    "ngeqslant nrightarrow nleftarrow nRightarrow nLeftarrow nleftrightarrow nLeftrightarrow " +
    "nparallel nexists nshortmid nshortparallel nsubseteq nsupseteq nsubseteqq nsupseteqq nprec " +
    "nsucc npreceq nsucceq ntriangleleft ntriangleright ntrianglelefteq ntrianglerighteq nvdash " +
    "nvDash nVdash nVDash newline newcommand nolimits nobreakspace normalsize nolinebreak " +
    "text textbf textit textrm textsf texttt textnormal textup textmd textstyle times theta " +
    "thetasym tau tan tanh to top tilde triangle triangleq trianglelefteq trianglerighteq " +
    "triangleleft triangleright therefore thickapprox thicksim thinspace thickspace tfrac " +
    "tbinom tiny tag"
  ).split(" "),
);

const ESCAPE = new RegExp(ESCAPE_SOURCE, "g");
const MATH_OR_ESCAPE = new RegExp(
  String.raw`(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)|` + ESCAPE_SOURCE,
  "g",
);

// Private-use placeholder that hides an escaped dollar while the maths regions are matched.
const ESCAPED_DOLLAR = String.fromCharCode(0xe000);

/** What an escape becomes; a bare LaTeX command is returned as written. */
function replacement(match: string, letter: string | undefined, rest: string): string {
  if (letter !== undefined && LATEX_COMMANDS.has(letter + rest)) return match;
  return (letter === "t" ? " " : "\n") + rest;
}

/** The escapes of one stretch of text that holds no maths. */
export function unescapeLiteralBreaks(text: string): string {
  return text.includes("\\") ? text.replace(ESCAPE, replacement) : text;
}

/** The escapes of a whole text, leaving the contents of `$...$` and `$$...$$` as they are. */
export function normalizeAiText(text: string): string {
  if (!text.includes("\\")) return text;
  const guarded = text.replace(/\\\$/g, ESCAPED_DOLLAR);
  const converted = guarded.replace(
    MATH_OR_ESCAPE,
    (match, math: string | undefined, letter: string | undefined, rest: string) =>
      math === undefined ? replacement(match, letter, rest) : match,
  );
  return converted.replaceAll(ESCAPED_DOLLAR, "\\$");
}
