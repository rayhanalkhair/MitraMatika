// The verification of one solution (SOL-03, Ruling R26). The model wrote both the answer and its
// claims, so a claim alone can only vouch for the answer when it recomputes it from the problem's
// own numbers:
// - the claims run through the existing deterministic verifier (verifyClaims); any failure is a
//   mismatch;
// - a passing claim "checks the answer" only when its result is the final answer, it uses at least
//   one number of the problem text, every number it uses comes from the problem (or is 1, 2 or
//   100: halves, squares, percent), and none of them is the answer itself. So "42 = 42",
//   "42 * 1", "x = 42" and "6 * 7" for a problem without 6 and 7 never check anything;
// - an independent second solve of the same problem (the cross-check, solve.ts) must agree.
// Status: a failing claim or a disagreeing cross-check is `ketidaksesuaian`; an agreeing
// cross-check gives `terverifikasi` with a claim that checks the answer, else `dicek_silang`;
// while the cross-check is pending or could not run, `belum_dapat_diverifikasi`. The badge never
// says more than was checked. Numbers compare the way the verifier compares answers (Indonesian
// decimals, fractions and percent: `0,5`, `1/2` and `50%` are the same, PRD AC-12); a claim's
// machine value with a dot (`1.500`) is a decimal, never thousands.
import {
  compareAnswers,
  numbersEquivalent,
  parseNumber,
  VERIFIER_VERSION,
  verifyClaims,
  type Claim,
  type ClaimResult,
  type VerificationStatus,
} from "@/features/verification";
import type { SolutionAnswer } from "../schema/answers";

/** The independent second solve: still running, agreeing, disagreeing, or not available. */
export type CrossCheck = "pending" | "agree" | "disagree" | "unavailable";

export interface VerificationReport {
  verifierVersion: string;
  /** Whether a passing claim recomputes the final answer from the problem's own numbers. */
  answerChecked: boolean;
  crossCheck: CrossCheck;
  /** The cross-check's own answer (shown when it disagrees). */
  crossCheckAnswer: string | null;
  results: { type: Claim["type"]; status: ClaimResult["status"]; detail: string }[];
}

/** Constants a recomputation may use without the problem naming them (halves, squares, %). */
const STRUCTURAL = [1, 2, 100];

/**
 * The value of a final answer as the verifier reads numbers: maths delimiters, `\frac{a}{b}`,
 * `\%` and thin spaces are rewritten, and a leading `x =` is dropped.
 */
export function answerValue(value: string): string {
  return value
    .replace(/\$/g, "")
    .replace(/\\[dt]?frac\{([^{}]+)\}\{([^{}]+)\}/g, "$1/$2")
    .replace(/\\%/g, "%")
    .replace(/\\[,;!]|\\ /g, "")
    .trim()
    .replace(/^[A-Za-z][A-Za-z0-9_]*\s*=\s*/, "")
    .trim();
}

/** A machine value (plain maths syntax): a dot is the decimal point, never a thousands mark. */
function machineValue(value: string): string {
  const trimmed = value.trim();
  return /^-?\d+\.\d+$/.test(trimmed) ? trimmed.replace(".", ",") : trimmed;
}

/** The numbers written in the problem text (Indonesian decimals and thousands). */
export function problemNumbers(text: string): Set<number> {
  const numbers = new Set<number>();
  for (const token of text.match(/\d+(?:[.,]\d+)*/g) ?? []) {
    const value = parseNumber(token);
    if (value !== null) numbers.add(value);
  }
  return numbers;
}

/** The numeric literals of an expression in plain maths syntax. */
function literalsOf(expression: string): number[] {
  return (expression.match(/\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi) ?? []).map(Number);
}

const close = (a: number, b: number) =>
  Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const within = (set: Iterable<number>, value: number) =>
  [...set].some((member) => close(member, value));

/** Whether the claim recomputes `value` from the problem's own numbers (R26). */
function recomputesAnswer(
  result: ClaimResult,
  value: string,
  numbers: Set<number>,
): boolean {
  if (result.status !== "pass") return false;
  const claim = result.claim;
  let source: string;
  if (claim.type === "numeric_eval") {
    if (compareAnswers(claim.expected, value) !== "match") return false;
    source = claim.expression;
  } else if (claim.type === "equation_solution") {
    if (
      claim.solutions.length !== 1 ||
      compareAnswers(claim.solutions[0], value) !== "match"
    ) {
      return false;
    }
    source = claim.equation;
  } else {
    return false;
  }
  const answer = parseNumber(value);
  if (answer === null) return false;
  const literals = literalsOf(source);
  return (
    literals.length > 0 &&
    !literals.some((literal) => close(literal, answer)) &&
    literals.some((literal) => within(numbers, literal)) &&
    literals.every((literal) => within(numbers, literal) || within(STRUCTURAL, literal))
  );
}

/** The claims with their machine values read as decimals (`1.500` is 1.5). */
function withMachineValues(claims: SolutionAnswer["verification_claims"]): Claim[] {
  return claims.map((claim) => {
    if (claim.type === "numeric_eval") {
      return { ...claim, expected: machineValue(claim.expected) };
    }
    if (claim.type === "equation_solution") {
      return { ...claim, solutions: claim.solutions.map(machineValue) };
    }
    return claim;
  });
}

/** Whether two answers agree: numbers in any notation; texts only when they are the same text. */
export function crossCheckAgreement(
  main: string,
  other: string,
): Exclude<CrossCheck, "pending"> {
  const a = answerValue(main);
  const b = machineValue(answerValue(other));
  if (parseNumber(a) !== null && parseNumber(b) !== null) {
    return numbersEquivalent(a, b) ? "agree" : "disagree";
  }
  return compareAnswers(a, b) === "match" ? "agree" : "unavailable";
}

/** The badge of a solution from what was checked (the rules above). */
export function decideSolutionStatus(input: {
  claimFailed: boolean;
  answerChecked: boolean;
  crossCheck: CrossCheck;
}): VerificationStatus {
  if (input.claimFailed || input.crossCheck === "disagree") return "ketidaksesuaian";
  if (input.crossCheck !== "agree") return "belum_dapat_diverifikasi";
  return input.answerChecked ? "terverifikasi" : "dicek_silang";
}

/** The same decision from a stored report, once its cross-check has an outcome. */
export function settleReport(
  report: VerificationReport,
  crossCheck: Exclude<CrossCheck, "pending">,
  crossCheckAnswer: string | null,
): { status: VerificationStatus; report: VerificationReport } {
  const next: VerificationReport = {
    ...report,
    crossCheck,
    crossCheckAnswer: crossCheckAnswer?.slice(0, 200) ?? null,
  };
  return {
    status: decideSolutionStatus({
      claimFailed: report.results.some((result) => result.status === "fail"),
      answerChecked: report.answerChecked,
      crossCheck,
    }),
    report: next,
  };
}

export function verifySolution(
  answer: SolutionAnswer,
  input: { problemMd: string; crossCheck: CrossCheck; crossCheckAnswer?: string | null },
): { status: VerificationStatus; report: VerificationReport } {
  const verified = verifyClaims(withMachineValues(answer.verification_claims));
  const value = answerValue(answer.final_answer.value);
  const numbers = problemNumbers(input.problemMd);
  const answerChecked = verified.results.some((result) =>
    recomputesAnswer(result, value, numbers),
  );
  const { crossCheck } = input;
  return {
    status: decideSolutionStatus({
      claimFailed: verified.status === "ketidaksesuaian",
      answerChecked,
      crossCheck,
    }),
    report: {
      verifierVersion: VERIFIER_VERSION,
      answerChecked,
      crossCheck,
      crossCheckAnswer: input.crossCheckAnswer?.slice(0, 200) ?? null,
      results: verified.results.map((result) => ({
        type: result.claim.type,
        status: result.status,
        detail: result.detail.slice(0, 300),
      })),
    },
  };
}
