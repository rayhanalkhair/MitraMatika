import { splitMath } from "@/components/math/split-math";

// How many columns a multiple-choice question's options use on paper (decision 8: "1, 2 or 4
// columns by length"). The length is the RENDERED length of the longest option: the visible
// characters, where a LaTeX command counts as one character and markup (braces, ^, _) counts as
// none. Thresholds (the text area of an A4/F4 page is about 170 mm wide, 12 pt, so a column of
// four holds about 10 characters after the "A." label and a column of two about 34):
//
//   - 4 columns: exactly four options and the longest is at most 10 characters;
//   - 2 columns: at least two options and the longest is at most 34 characters;
//   - 1 column: anything longer, an option with a line break, or fewer than two options.
export type OptionColumns = 1 | 2 | 4;

export const MAX_LENGTH_FOUR_COLUMNS = 10;
export const MAX_LENGTH_TWO_COLUMNS = 34;
const MULTI_LINE = 1000;

const TEXT_COMMAND =
  /\\(?:text|textrm|textbf|textit|mathrm|mathbf|mathit|mbox|operatorname)\b/g;
const SIZE_COMMAND = /\\(?:left|right)\b\.?/g;

const mathLength = (math: string): number =>
  math
    .replace(TEXT_COMMAND, "")
    .replace(SIZE_COMMAND, "")
    .replace(/\\[A-Za-z]+|\\[^A-Za-z]/g, "\u0001")
    .replace(/[{}^_&\s]/g, "").length;

// `**bold**` and `*italic*` print without their markers.
const withoutEmphasis = (text: string): string =>
  text
    .replace(/\*\*([^*\n]+?)\*\*/g, "$1")
    .replace(/(?<![*\w])\*([^*\n]+?)\*(?![*\w])/g, "$1");

/** The visible length of Markdown/LaTeX option text (a line break counts as very long). */
export function renderedLength(text: string): number {
  if (text.includes("\n")) return MULTI_LINE;
  return splitMath(text).reduce(
    (sum, segment) =>
      sum +
      (segment.kind === "text"
        ? withoutEmphasis(segment.value).length
        : mathLength(segment.value)),
    0,
  );
}

export function optionColumns(options: string[]): OptionColumns {
  if (options.length < 2) return 1;
  const longest = Math.max(...options.map(renderedLength));
  if (options.length === 4 && longest <= MAX_LENGTH_FOUR_COLUMNS) return 4;
  return longest <= MAX_LENGTH_TWO_COLUMNS ? 2 : 1;
}
