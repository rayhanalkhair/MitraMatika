import katex from "katex";

function extractSpans(text: string): string[] {
  // Protect escaped dollar signs so they never look like a delimiter.
  const placeholder = "\u0000";
  const guarded = text.replace(/\\\$/g, placeholder);

  const spans: string[] = [];
  let remaining = guarded;

  // Display math first ($$...$$), since it also contains single $ characters.
  remaining = remaining.replace(/\$\$([\s\S]+?)\$\$/g, (match) => {
    spans.push(match);
    return "";
  });

  // Inline math ($...$), not crossing a newline.
  remaining.replace(/\$([^$\n]+?)\$/g, (match) => {
    spans.push(match);
    return "";
  });

  return spans.map((s) => s.replace(new RegExp(placeholder, "g"), "\\$"));
}

function stripDelimiters(span: string): string {
  if (span.startsWith("$$") && span.endsWith("$$")) {
    return span.slice(2, -2);
  }
  return span.slice(1, -1);
}

// A run of 2+ backslashes directly followed by a KNOWN LaTeX command word is
// (almost certainly) an over-escaped command from the model writing "\\frac"
// where "\frac" was correct in the JSON string value. KaTeX's "ignore"
// strict mode renders this without throwing (it reads as a "\\" line-break
// command followed by literal text), so renderToString alone won't catch it.
//
// This deliberately matches an ALLOWLIST of command words, not "any letter":
// a cases/array line break ("\\") is legitimately allowed to be followed
// directly by a letter with NO space (e.g. "x+y=1\\\\x-y=2" in a cases
// environment — whitespace after "\\" is a style convention, not a LaTeX
// requirement), and SPLDV (systems of two-variable linear equations) is a
// real curriculum topic that naturally produces this shape. Restricting the
// match to real command words avoids flagging a line break immediately
// followed by an ordinary variable letter (x, y, k, m, ...), while still
// catching every over-escaped command actually observed in real model
// output. Extend this list if a new over-escaped command is ever observed.
const KNOWN_LATEX_COMMANDS = [
  "frac",
  "dfrac",
  "sqrt",
  "pi",
  "theta",
  "times",
  "div",
  "cdot",
  "approx",
  "neq",
  "leq",
  "geq",
  "angle",
  "parallel",
  "perp",
  "triangle",
  "Rightarrow",
  "Leftrightarrow",
  "text",
  "mathrm",
  "begin",
  "end",
  "left",
  "right",
  "circ",
];
// A negative lookahead for a following letter, not "\b" — "\b" is a
// word-boundary assertion that fails between a letter and a DIGIT (e.g.
// "\times3" has no word boundary between "s" and "3", since both are \w),
// which would wrongly let a real over-escaped command through when it's
// directly followed by a number. The lookahead only guards against the
// command name being a prefix of a longer identifier (e.g. "parallel" as a
// prefix of "parallelogram") — anything else following (digits, braces,
// another backslash, whitespace, end of string) is a normal LaTeX context.
const OVER_ESCAPED_BACKSLASH = new RegExp(
  `\\\\{2,}(?:${KNOWN_LATEX_COMMANDS.join("|")})(?![a-zA-Z])`,
);

export function findInvalidMathSpans(text: string): string[] {
  const invalid: string[] = [];
  for (const span of extractSpans(text)) {
    const tex = stripDelimiters(span);
    if (OVER_ESCAPED_BACKSLASH.test(tex)) {
      invalid.push(span);
      continue;
    }
    try {
      katex.renderToString(tex, { throwOnError: true, strict: "ignore" });
    } catch {
      invalid.push(span);
    }
  }
  return invalid;
}
