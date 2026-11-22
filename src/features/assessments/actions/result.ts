import type { ApprovalProblem } from "../service/approval";

// The wire shape of the item and section actions (a "use server" file may export only async
// functions, so the types live here). `reason` is a key of assessments.errors in the catalogs.
export type ActionFailureReason =
  | "unauthenticated"
  | "invalid"
  | "generic"
  | "notFound"
  | "approved"
  | "conflict"
  | "sectionNotFound"
  | "notBanked"
  | "pendingCheck"
  | "tooManyItems"
  | "tooManyAtOnce"
  | "tooMany"
  | "lastSection"
  | "invalidPoints"
  | "itemNotFound"
  | "notReady";

export type ActionResult<T extends object = object> =
  | ({ ok: true } & T)
  // `questionId` names the question an add was refused for (notBanked, pendingCheck); `problems`
  // lists everything that blocks an approval (notReady).
  | {
      ok: false;
      reason: ActionFailureReason;
      questionId?: string;
      problems?: ApprovalProblem[];
    };

/** A typed failure that carries more than its key. */
export type DetailedFailure =
  | { code: ActionFailureReason; questionId: string }
  | { code: ActionFailureReason; problems: ApprovalProblem[] };
