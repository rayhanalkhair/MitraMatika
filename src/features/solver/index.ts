// The problem solver (decisions 10 and 11 of the materials plan). Pages import its UI from `ui/`
// and its Server Actions from `actions/`; this index carries no UI, so the trash and the job
// runner can use it without a cycle.
export {
  ALTERNATIVE_METHOD_JOB,
  EXTRACT_PROBLEM_JOB,
  MAX_METHODS,
  MAX_PROBLEM_CHARS,
  MAX_SOLVER_PHOTO_BYTES,
  PHOTO_RETENTION_MS,
  RECENT_SESSIONS,
  SOLVE_PROBLEM_JOB,
  SOLVER_JOB_TYPES,
  SOLVER_PHOTO_ACCEPT,
  USER_DAILY_SOLVES,
} from "./schema/solver";
export type {
  AlternativeError,
  ConfirmExtractionError,
  ExtractionFlag,
  FinalAnswer,
  FinalizePhotoError,
  SessionStatus,
  SolutionStep,
  SolveAgainError,
  StartPhotoError,
  TextSessionError,
} from "./schema/solver";
export { sessionPrefix } from "./service/keys";
export { solvesLeft } from "./service/quota";
export type { SolverDb } from "./service/quota";
export {
  confirmExtraction,
  createTextSession,
  finalizePhotoSession,
  getSession,
  listRecentSessions,
  requestAlternative,
  solveAgain,
  startPhotoSession,
} from "./service/sessions";
export type {
  RecentSession,
  SessionState,
  SessionView,
  SolutionItem,
} from "./service/sessions";
export type { ExtractionIssue } from "./service/issues";
export { createExtractProblemHandler, extractProblem } from "./service/extract";
export { createSolveProblemHandler, solveProblem } from "./service/solve";
export { alternativeMethod, createAlternativeMethodHandler } from "./service/alternative";
export { verifySolution } from "./service/verify-solution";
export { registerSolverHandlers } from "./service/register";
export { sweepSolver } from "./service/photos";
export { handleSolverPhotoRequest } from "./service/photo-route";
export type { SolverPhotoDeps } from "./service/photo-route";
