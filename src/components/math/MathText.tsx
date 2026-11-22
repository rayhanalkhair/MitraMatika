import katex from "katex";
import "katex/dist/katex.min.css";
import { withDecimalComma } from "./decimal-comma";
import { splitMath } from "./split-math";

function render(value: string, displayMode: boolean): string | null {
  try {
    // Only KaTeX's own output is ever injected as HTML. `trust: false` blocks \href and friends.
    return katex.renderToString(withDecimalComma(value), {
      displayMode,
      throwOnError: true,
      trust: false,
      strict: "ignore",
      // Bound box sizes (em) and macro expansion: the defaults allow a 100000em box and ~1000x
      // expansion, which model text must not be able to trigger.
      maxSize: 10,
      maxExpand: 100,
    });
  } catch {
    return null; // invalid math: the caller shows the source text instead
  }
}

// B-005: the model sometimes writes a unit or variable exponent as plain text outside `$...$`
// (`24 cm^2`, `x^2`, `10^6`). Show it as a superscript at render time; the stored text is never
// changed. Only a short base (1-4 letters or a number, which may follow a digit as in `24cm^2`) with
// a short exponent counts, never one that follows a letter or backslash, so a stray
// caret in prose is left alone.
const UNIT_EXPONENT = /(?<![\p{L}\\])([\p{L}]{1,4}|\d+)\^(-?\d{1,2})(?![\p{L}\p{N}])/gu;

function withSuperscripts(value: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of value.matchAll(UNIT_EXPONENT)) {
    if (match.index > last) parts.push(value.slice(last, match.index));
    parts.push(match[1], <sup key={match.index}>{match[2]}</sup>);
    last = match.index + match[0].length;
  }
  if (parts.length === 0) return value;
  if (last < value.length) parts.push(value.slice(last));
  return parts;
}

export function MathText({ text, className }: { text: string; className?: string }) {
  return (
    <span
      className={className}
      style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
    >
      {splitMath(text).map((segment, index) => {
        if (segment.kind === "text")
          return <span key={index}>{withSuperscripts(segment.value)}</span>;
        const html = render(segment.value, segment.kind === "block");
        if (html === null) {
          const source =
            segment.kind === "block" ? `$$${segment.value}$$` : `$${segment.value}$`;
          return <span key={index}>{source}</span>;
        }
        return segment.kind === "block" ? (
          <span
            key={index}
            className="block max-w-full overflow-x-auto"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <span key={index} dangerouslySetInnerHTML={{ __html: html }} />
        );
      })}
    </span>
  );
}
