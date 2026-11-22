import { compareAnswers, parseNumber } from "@/features/verification";
import type { MultipleChoiceQuestion } from "../schema/schemas";

export type StructuralFindingCode =
  "options_not_distinct" | "key_not_final_answer" | "length_out_of_bounds";

export interface StructuralFinding {
  code: StructuralFindingCode;
  message: string;
}

// Deliberately generous: they exist to stop runaway output, not to police style. Tuned in the pilot.
export const LENGTH_LIMITS = {
  stem: 1_200,
  option: 300,
  explanation: 2_000,
  step: 500,
  maxSteps: 12,
} as const;

// Removes the notation that does not change what a value is: math delimiters, \text{}, \left and
// \right, LaTeX spacing commands and all whitespace. Case is handled by compareAnswers.
function stripMath(text: string): string {
  return text
    .replace(/\\text\{([^}]*)\}/g, "$1")
    .replace(/\\(?:left|right)\b/g, "")
    .replace(/\\[,;:! ]/g, "")
    .replace(/\\[()[\]]/g, "")
    .replace(/\$/g, "")
    .replace(/(\d)\s+(?=\d)/g, "$1_")
    .replace(/\s+/g, "");
}

// Written decimal count of a plain number; fractions and percentages are not rounded values.
function decimalCount(text: string): number {
  const comma = /^-?\d+,(\d+)$/.exec(text);
  if (comma) return comma[1].length;
  if (/^-?[1-9]\d{0,2}(\.\d{3})+$/.test(text)) return 0;
  const dot = /^-?\d+\.(\d+)$/.exec(text);
  return dot ? dot[1].length : 0;
}

// A mismatch is reported only when it is proven: two numbers where the option is not the answer
// rounded to the option's own precision, or two plain words. Notation differences between
// expressions are left to the claim verifier.
function provenMismatch(markedText: string, answerText: string): boolean {
  if (compareAnswers(markedText, answerText) !== "mismatch") return false;
  const marked = parseNumber(markedText);
  const answer = parseNumber(answerText);
  if (marked !== null && answer !== null) {
    if (/[/%]/.test(markedText)) return true;
    const k = decimalCount(markedText);
    if (
      decimalCount(answerText) > k &&
      Math.abs(answer - marked) <= 0.5 * 10 ** -k + 1e-12
    ) {
      return false;
    }
    return true;
  }
  const word = /^[\p{L}-]+$/u;
  return word.test(markedText) && word.test(answerText);
}

// Pure and deterministic. It reports only what it can prove, so a pair that cannot be compared
// (a number against text) is never a finding; claim verification (P1-12) owns that case.
export function checkMultipleChoice(
  question: MultipleChoiceQuestion,
): StructuralFinding[] {
  const findings: StructuralFinding[] = [];
  const options = question.options.map((option) => ({
    label: option.label,
    text: stripMath(option.text_md),
  }));

  const collisions: string[] = [];
  for (let i = 0; i < options.length; i += 1) {
    for (let j = i + 1; j < options.length; j += 1) {
      if (compareAnswers(options[i].text, options[j].text) === "match") {
        collisions.push(`${options[i].label} dan ${options[j].label}`);
      }
    }
  }
  if (collisions.length > 0) {
    findings.push({
      code: "options_not_distinct",
      message: `Pilihan bernilai sama: ${collisions.join("; ")}.`,
    });
  }

  const answer = stripMath(question.answer.machine);
  const marked = options.find((option) => option.label === question.correctLabel);
  if (marked && provenMismatch(marked.text, answer)) {
    findings.push({
      code: "key_not_final_answer",
      message: `Pilihan yang ditandai (${question.correctLabel}) tidak sama dengan jawaban akhir.`,
    });
  } else if (!marked || compareAnswers(marked.text, answer) !== "match") {
    const other = options.find(
      (option) =>
        option.label !== question.correctLabel &&
        compareAnswers(option.text, answer) === "match",
    );
    if (other) {
      findings.push({
        code: "key_not_final_answer",
        message: `Pilihan ${other.label} sama dengan jawaban akhir, tetapi bukan yang ditandai.`,
      });
    }
  }

  if (question.stem_md.length > LENGTH_LIMITS.stem) {
    findings.push({
      code: "length_out_of_bounds",
      message: `Teks soal melebihi ${String(LENGTH_LIMITS.stem)} karakter.`,
    });
  }
  if (question.options.some((option) => option.text_md.length > LENGTH_LIMITS.option)) {
    findings.push({
      code: "length_out_of_bounds",
      message: `Ada pilihan yang melebihi ${String(LENGTH_LIMITS.option)} karakter.`,
    });
  }
  if (question.explanation_md.length > LENGTH_LIMITS.explanation) {
    findings.push({
      code: "length_out_of_bounds",
      message: `Pembahasan melebihi ${String(LENGTH_LIMITS.explanation)} karakter.`,
    });
  }
  if (
    question.steps.length > LENGTH_LIMITS.maxSteps ||
    question.steps.some((step) => step.length > LENGTH_LIMITS.step)
  ) {
    findings.push({
      code: "length_out_of_bounds",
      message: `Langkah penyelesaian melebihi batas (${String(LENGTH_LIMITS.maxSteps)} langkah, ${String(LENGTH_LIMITS.step)} karakter per langkah).`,
    });
  }

  return findings;
}
