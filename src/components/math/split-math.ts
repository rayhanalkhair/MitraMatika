export interface MathSegment {
  kind: "text" | "inline" | "block";
  value: string;
}

// Block math ($$…$$) first, then inline ($…$ on one line). Anything else, including an unbalanced
// dollar sign, stays text.
const PATTERN = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;

// An escaped dollar (`\$`) is never a delimiter (same rule as the generation-time check in
// `features/generation/service/katex-check.ts`). It is hidden behind a private placeholder while matching.
const ESCAPED_DOLLAR = "";

export function splitMath(text: string): MathSegment[] {
  const guarded = text.replace(/\\\$/g, ESCAPED_DOLLAR);
  // In text a `\$` shows as a literal `$`; inside math it stays `\$` (valid LaTeX for a dollar).
  const asText = (value: string) => value.replaceAll(ESCAPED_DOLLAR, "$");
  const asMath = (value: string) => value.replaceAll(ESCAPED_DOLLAR, "\\$");
  const segments: MathSegment[] = [];
  let last = 0;
  for (const match of guarded.matchAll(PATTERN)) {
    const index = match.index;
    if (index > last)
      segments.push({ kind: "text", value: asText(guarded.slice(last, index)) });
    const block = match.at(1);
    if (block !== undefined) segments.push({ kind: "block", value: asMath(block) });
    else segments.push({ kind: "inline", value: asMath(match.at(2) ?? "") });
    last = index + match[0].length;
  }
  if (last < guarded.length)
    segments.push({ kind: "text", value: asText(guarded.slice(last)) });
  return segments;
}
