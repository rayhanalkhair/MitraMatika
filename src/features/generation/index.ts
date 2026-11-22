export { generateMultipleChoiceBatch } from "./service/generate-mc";
export type { GenerateMcParams } from "./service/generate-mc";
export { findInvalidMathSpans } from "./service/katex-check";
export { buildGenerateMcPrompt } from "./service/prompts/generate-mc.id";
export { buildSolveIndependentPrompt } from "./service/prompts/solve-independent.id";
export {
  claimSchema,
  multipleChoiceBatchSchema,
  multipleChoiceQuestionSchema,
} from "./schema/schemas";
export type {
  Claim,
  MultipleChoiceBatch,
  MultipleChoiceQuestion,
} from "./schema/schemas";
export { solveIndependent } from "./service/solve-independent";
export type {
  SolveIndependentParams,
  SolveIndependentResult,
} from "./service/solve-independent";
export { buildContextPack } from "./service/context-pack";
export { GENERATE_MC_PROMPT_VERSION } from "./service/prompts/generate-mc.id";
export { generationParamsSchema } from "./service/request-params";
export type { GenerationParams } from "./service/request-params";
export type { GenerateMcOptions } from "./service/generate-mc";
export { createGenerateBatchHandler } from "./service/generate-batch";
export type { GenerateBatchDeps } from "./service/generate-batch";
export { checkMultipleChoice, LENGTH_LIMITS } from "./service/structural-checks";
export type {
  StructuralFinding,
  StructuralFindingCode,
} from "./service/structural-checks";
export { buildTraces, getQuestionTrace, getRequestTraces } from "./service/trace";
export type { QuestionTrace } from "./service/trace";
export {
  AUDIT_QUESTION_APPROVED,
  AUDIT_QUESTION_DECISION_RESET,
  AUDIT_QUESTION_EDITED,
  AUDIT_QUESTION_REJECTED,
  AUDIT_QUESTION_RESTORED,
  AUDIT_QUESTIONS_BANKED,
  AUDIT_REGENERATION_REQUESTED,
} from "./service/audit";
export { batchJson, questionJson, solverJson } from "./service/fixtures";
export { loadObjectiveCodes, persistDrafts } from "./service/persist";
export type { AnyDb } from "./service/persist";
export { registerGenerationHandlers } from "./service/register";
export { parseRequestSummary } from "./service/request-summary";
export { describeJobStatus } from "./service/status-message";
export type { StatusMessage } from "./service/status-message";
export {
  buildContext,
  seedCurriculum,
  seedGenerationRequest,
  solverPicking,
} from "./service/test-support";
export {
  fromDbStatus,
  isRegenerationMarker,
  toDbStatus,
} from "./service/verification-status";
export {
  insertRegenerationMarker,
  insertVerificationRun,
  persistRegeneratedVersion,
} from "./service/verify-persist";
export { questionsRequestedToday, USER_DAILY_QUESTION_LIMIT } from "./service/quota";
export {
  createRegenerateQuestionHandler,
  findPendingRegeneration,
  regenerateQuestion,
  requestRegeneration,
  settleRegenerationApproval,
  settleStrandedApprovals,
} from "./service/regenerate";
export type {
  RegenerateDeps,
  RegenerateRequestFailure,
  RegenerateRequestResult,
} from "./service/regenerate";
export {
  HINT_TEXT_MAX,
  REGENERATE_JOB_TYPE,
  regenerateHintSchema,
} from "./schema/regenerate-input";
export type { RegenerateHint } from "./schema/regenerate-input";
export { settleStrandedRegenerations } from "./service/maintenance";
export { listGenerationMaterials } from "./service/material-selection";
export { hasCitationFailure } from "./service/material-sources";
export type { GenerationMaterial } from "./service/material-selection";
// The shared model quota and call log, for other features' AI jobs (the materials structure
// proposal uses the same per-model lock, daily plan and ai_calls accounting).
export {
  createModelBudget,
  GENERATE_QUOTA,
  jakartaDayWindow,
  planQuota,
  planSharedWork,
  readRecentSpends,
  readSharedWorkSpends,
  SHARED_WORK_SHARE,
  SHARED_WORK_TASKS,
  SOLVE_QUOTA,
} from "./service/quota";
export { insertAiCall } from "./service/persist";
export {
  aiErrorCode,
  lockWaitMs,
  MIN_REMAINING_MS,
  pgCodeOf,
  providerRetryDelayMs,
  QUOTA_RETRY_MS,
} from "./service/step-support";
export type { Gateway } from "./service/step-support";
