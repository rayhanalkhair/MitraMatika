// What makes an extraction uncertain (SOL-02): a `[[?]]...[[?]]` part the vision model was unsure
// of (R14 form), a LaTeX span KaTeX cannot parse, an answer cut at the output cap, or no text at
// all. Any of them means the teacher must confirm or edit the text before anything is solved.
import { findInvalidMathSpans } from "@/features/generation";
import type { ExtractionFlag } from "../schema/solver";

export const MARKER = "[[?]]";

export type ExtractionIssue =
  | { kind: "uncertain"; text: string }
  | { kind: "katex"; text: string }
  | { kind: "truncated" }
  | { kind: "empty" };

/** The unsure parts between pairs of markers (an unpaired marker marks the rest of the text). */
export function uncertainParts(text: string): string[] {
  const pieces = text.split(MARKER);
  const parts: string[] = [];
  for (let i = 1; i < pieces.length; i += 2) {
    const part = pieces[i].trim();
    parts.push(part === "" ? MARKER : part.slice(0, 200));
  }
  return parts;
}

/** The flags stored with an extraction. */
export function extractionFlags(
  markdown: string,
  input: { truncated: boolean },
): ExtractionFlag[] {
  const flags: ExtractionFlag[] = [];
  if (markdown.includes(MARKER)) flags.push("uncertain");
  if (findInvalidMathSpans(markdown.split(MARKER).join("")).length > 0) {
    flags.push("katex");
  }
  if (input.truncated) flags.push("truncated");
  if (markdown.trim() === "") flags.push("empty");
  return flags;
}

/** The list the confirmation screen shows, from the text and its stored flags. */
export function extractionIssues(
  markdown: string | null,
  flags: readonly string[],
): ExtractionIssue[] {
  const text = markdown ?? "";
  const issues: ExtractionIssue[] = [
    ...uncertainParts(text).map((part) => ({ kind: "uncertain" as const, text: part })),
    ...findInvalidMathSpans(text.split(MARKER).join("")).map((span) => ({
      kind: "katex" as const,
      text: span.slice(0, 200),
    })),
  ];
  if (flags.includes("truncated")) issues.push({ kind: "truncated" });
  if (text.trim() === "") issues.push({ kind: "empty" });
  return issues;
}
