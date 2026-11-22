export { compareAnswers } from "./service/compare-answers";
export type { AnswerComparison } from "./service/compare-answers";
export { evaluateClaim } from "./service/claims";
export type { Claim, ClaimResult } from "./service/claims";
export { numbersEquivalent, parseNumber } from "./service/number";
export { verifyClaims } from "./service/verify";
export type { VerificationStatus } from "./service/verify";
export {
  CROSS_CHECK_DISAGREES,
  crossCheckVerdict,
  decideStatus,
  VERIFIER_VERSION,
} from "./service/decide-status";
export type { CrossCheckVerdict, QuestionStatus } from "./service/decide-status";
