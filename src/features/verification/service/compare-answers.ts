import { numbersEquivalent, parseNumber } from "./number";

export type AnswerComparison = "match" | "mismatch" | "incomparable";

function normaliseText(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

// One definition of "this option is that answer", shared by the choice_matches_answer claim and
// the structural checks. Two numbers (Indonesian formats, fractions, percent) are compared as
// numbers, two non-numbers as normalised text, and a number against a non-number cannot be
// compared automatically.
export function compareAnswers(a: string, b: string): AnswerComparison {
  const aIsNumber = parseNumber(a) !== null;
  const bIsNumber = parseNumber(b) !== null;
  if (aIsNumber !== bIsNumber) return "incomparable";
  if (aIsNumber) return numbersEquivalent(a, b) ? "match" : "mismatch";
  return normaliseText(a) === normaliseText(b) ? "match" : "mismatch";
}
