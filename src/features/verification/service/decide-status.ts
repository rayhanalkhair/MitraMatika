import type { ClaimResult } from "./claims";
import { compareAnswers } from "./compare-answers";

// Recorded with every verification run.
export const VERIFIER_VERSION = "p1-12.1";

export const CROSS_CHECK_DISAGREES =
  "Model penyelesai independen memilih jawaban berbeda.";

export type CrossCheckVerdict = "agree" | "disagree" | "unknown";

export type QuestionStatus =
  "terverifikasi" | "dicek_silang" | "belum_dapat_diverifikasi" | "ketidaksesuaian";

/**
 * The solver agrees when it chose the question's own key; the machine answers only rescue the case
 * where it named another option that holds the same value. A notation-only difference between two
 * non-numeric machine answers is therefore never a contradiction on its own.
 */
export function crossCheckVerdict(input: {
  solverLabel: string;
  solverMachine: string;
  questionLabel: string;
  questionMachine: string;
}): CrossCheckVerdict {
  if (input.solverLabel === input.questionLabel) return "agree";
  return compareAnswers(input.solverMachine, input.questionMachine) === "match"
    ? "agree"
    : "disagree";
}

/**
 * D-007 / ADR-0011: any contradiction (a failing claim or a disagreeing solver) is
 * `ketidaksesuaian`; otherwise deterministic coverage gives `terverifikasi`, the solver alone gives
 * `dicek_silang`, and neither gives `belum_dapat_diverifikasi`.
 */
export function decideStatus(
  claims: ClaimResult[],
  crossCheck: CrossCheckVerdict,
): { status: QuestionStatus; reasons: string[] } {
  const failed = claims.filter((claim) => claim.status === "fail");
  if (failed.length > 0) {
    return { status: "ketidaksesuaian", reasons: failed.map((claim) => claim.detail) };
  }
  if (crossCheck === "disagree") {
    return { status: "ketidaksesuaian", reasons: [CROSS_CHECK_DISAGREES] };
  }
  if (claims.some((claim) => claim.status === "pass")) {
    return { status: "terverifikasi", reasons: [] };
  }
  if (crossCheck === "agree") return { status: "dicek_silang", reasons: [] };
  return { status: "belum_dapat_diverifikasi", reasons: [] };
}
