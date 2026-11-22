import { z } from "zod";
import type { RequestReview } from "@/features/review/service/review";
import { isTerminal } from "@/lib/jobs/client/status";
import type { JobStatusValue } from "@/lib/jobs/status";

const label = z.enum(["A", "B", "C", "D"]);
const reviewSchema = z.object({
  requested: z.number(),
  curriculum: z
    .object({
      versionCode: z.string(),
      versionTitle: z.string(),
      elementCode: z.string(),
      elementName: z.string(),
      topicTitle: z.string(),
      objectives: z.array(z.object({ code: z.string(), text: z.string() })),
      sourceAnchor: z.string().nullable(),
    })
    .nullable(),
  questions: z.array(
    z.object({
      questionId: z.string(),
      versionId: z.string(),
      versionNo: z.number(),
      rowVersion: z.number(),
      decision: z.enum(["draft", "approved", "rejected"]),
      override: z.boolean(),
      banked: z.boolean(),
      difficulty: z.enum(["mudah", "sedang", "sulit"]),
      stemMd: z.string(),
      options: z.array(z.object({ label, textMd: z.string() })),
      correctLabel: label,
      answerDisplayMd: z.string(),
      explanationMd: z.string(),
      steps: z.array(z.string()),
      sources: z.array(
        z.object({
          title: z.string().nullable(),
          page: z.number().nullable(),
          href: z.string().nullable(),
        }),
      ),
      verification: z.object({
        status: z.enum([
          "terverifikasi",
          "dicek_silang",
          "belum_dapat_diverifikasi",
          "ketidaksesuaian",
        ]),
        checked: z.boolean(),
        checks: z.array(
          z.object({
            type: z.enum([
              "numeric_eval",
              "expression_equivalent",
              "equation_solution",
              "choice_matches_answer",
              "other",
            ]),
            status: z.enum(["pass", "fail", "unsupported"]),
            detail: z.string(),
          }),
        ),
        crossCheck: z.enum(["agree", "disagree", "unknown"]).nullable(),
        regenerated: z.boolean(),
        regenerationFailed: z.boolean(),
      }),
    }),
  ),
});

export type ReviewResult =
  { kind: "ok"; review: RequestReview } | { kind: "signed-out" } | { kind: "not-found" };

// What the list knows about the job: its status, undefined while that is still being loaded, or
// "stopped" when there is nothing to wait for (no job, or the job answer was signed-out/not-found),
// or "unreachable" when the job query failed and has no data (poll slowly, like after an error).
export type ReviewJobStatus = JobStatusValue | "stopped" | "unreachable" | undefined;

// 3 s while the job is queued or running (the list also needs the verification statuses), 15 s
// while it is deferred (nothing changes until the quota resets), nothing once it has finished or
// is unreachable (the hook refetches once more on the terminal transition). Unknown counts as running.
export function reviewPollInterval(jobStatus: ReviewJobStatus): number | false {
  if (jobStatus === "stopped") return false;
  if (jobStatus === "unreachable") return 15_000;
  if (jobStatus === undefined) return 3_000;
  if (isTerminal(jobStatus)) return false;
  return jobStatus === "deferred" ? 15_000 : 3_000;
}

// Polling cadence for a query state, like `pollIntervalFor` for the job: a failed fetch keeps
// retrying every 15 s so a failed final fetch cannot leave stale statuses on screen; signed-out
// and not-found answers stop polling.
export function reviewRefetchInterval(
  state: { status: "pending" | "error" | "success"; data?: ReviewResult },
  jobStatus: ReviewJobStatus,
): number | false {
  if (jobStatus === "stopped") return false;
  if (state.status === "error") return 15_000;
  if (state.data && state.data.kind !== "ok") return false;
  return reviewPollInterval(jobStatus);
}

export async function fetchRequestReview(
  requestId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReviewResult> {
  const response = await fetchImpl(`/api/generation/${requestId}/questions`, {
    headers: { accept: "application/json" },
    credentials: "same-origin",
    redirect: "manual",
  });
  if (response.type === "opaqueredirect") return { kind: "signed-out" };
  if (response.status >= 300 && response.status < 400) return { kind: "signed-out" };
  if (response.status === 401 || response.status === 403) return { kind: "signed-out" };
  if (response.status === 404) return { kind: "not-found" };
  if (!response.ok) throw new Error(`Review request failed (${String(response.status)})`);
  return { kind: "ok", review: reviewSchema.parse(await response.json()) };
}

// Optimistic copy of a review after a decision: only the targeted question changes, and its row
// version moves on exactly as the server will bump it.
// Optimistic copy of a review after a successful save to the bank: every approved question that was
// not banked yet now is. The refetch that follows is the truth; this only avoids a stale screen.
export function patchReviewBanked(review: RequestReview): RequestReview {
  return {
    ...review,
    questions: review.questions.map((question) =>
      question.decision === "approved" && !question.banked
        ? { ...question, banked: true }
        : question,
    ),
  };
}

export function patchReviewDecision(
  review: RequestReview,
  questionId: string,
  decision: "draft" | "approved" | "rejected",
  override: boolean,
): RequestReview {
  return {
    ...review,
    questions: review.questions.map((question) =>
      question.questionId === questionId
        ? { ...question, decision, override, rowVersion: question.rowVersion + 1 }
        : question,
    ),
  };
}
