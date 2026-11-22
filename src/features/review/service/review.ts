import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { teacherSourceAnchor } from "@/features/curriculum";
import { generationRequests, questions, questionVersions } from "@/lib/db/schema";
import type { AnyDb } from "@/features/generation";
import { generationParamsSchema } from "@/features/generation";
import { getRequestTraces, type QuestionTrace } from "@/features/generation";

export interface ReviewCheck {
  type:
    | "numeric_eval"
    | "expression_equivalent"
    | "equation_solution"
    | "choice_matches_answer"
    | "other";
  status: "pass" | "fail" | "unsupported";
  detail: string;
}

export interface ReviewQuestion {
  questionId: string;
  versionId: string;
  versionNo: number;
  rowVersion: number;
  decision: "draft" | "approved" | "rejected";
  // True when a teacher override note exists; the note itself is never selected.
  override: boolean;
  // In the bank: banked_at is set AND the approval still matches the current version.
  banked: boolean;
  difficulty: "mudah" | "sedang" | "sulit";
  stemMd: string;
  options: { label: "A" | "B" | "C" | "D"; textMd: string }[];
  correctLabel: "A" | "B" | "C" | "D";
  answerDisplayMd: string;
  explanationMd: string;
  steps: string[];
  // Material citations: "Sumber: <title>, hal. <page>" linking to the page viewer (`href`) while
  // the material is live; `title` null means the material was deleted for good.
  sources: { title: string | null; page: number | null; href: string | null }[];
  verification: {
    status:
      "terverifikasi" | "dicek_silang" | "belum_dapat_diverifikasi" | "ketidaksesuaian";
    checked: boolean;
    checks: ReviewCheck[];
    crossCheck: "agree" | "disagree" | "unknown" | null;
    regenerated: boolean;
    regenerationFailed: boolean;
  };
}

export interface RequestReview {
  requested: number;
  curriculum: {
    versionCode: string;
    versionTitle: string;
    elementCode: string;
    elementName: string;
    topicTitle: string;
    objectives: { code: string; text: string }[];
    sourceAnchor: string | null;
  } | null;
  questions: ReviewQuestion[];
}

const label = z.enum(["A", "B", "C", "D"]);
const contentSchema = z.object({
  options: z
    .array(z.object({ label, text_md: z.string() }))
    .length(4)
    .refine((options) => new Set(options.map((option) => option.label)).size === 4),
  answer: z.object({ display_md: z.string(), correctLabel: label }),
  steps: z.array(z.string()),
});
const CHECK_TYPES = [
  "numeric_eval",
  "expression_equivalent",
  "equation_solution",
  "choice_matches_answer",
] as const;
const STATUSES = [
  "terverifikasi",
  "dicek_silang",
  "belum_dapat_diverifikasi",
  "ketidaksesuaian",
] as const;
const DIFFICULTIES = ["mudah", "sedang", "sulit"] as const;
// questions.status -> what the teacher sees. Reject writes "archived" (spec decision 1).
const DECISIONS: Record<string, ReviewQuestion["decision"]> = {
  draft: "draft",
  approved: "approved",
  archived: "rejected",
};

function projectChecks(trace: QuestionTrace): ReviewCheck[] {
  return trace.verification.checks.map((check) => ({
    type: (CHECK_TYPES as readonly string[]).includes(check.type)
      ? (check.type as ReviewCheck["type"])
      : "other",
    status:
      check.status === "pass" || check.status === "fail" ? check.status : "unsupported",
    detail: check.detail,
  }));
}

// The page of a citation: the cited page's number, else the one in its anchor ("hal. 5"), which
// outlives the material.
function sourcePage(source: QuestionTrace["materialSources"][number]): number | null {
  if (source.pageNo !== null) return source.pageNo;
  const match = /(\d+)/.exec(source.anchorLabel);
  return match ? Number(match[1]) : null;
}

export function projectSources(trace: QuestionTrace): ReviewQuestion["sources"] {
  return trace.materialSources.map((source) => {
    const page = sourcePage(source);
    return {
      title: source.title,
      page,
      href:
        source.live && source.materialId !== null && page !== null
          ? `/materials/${source.materialId}?page=${String(page)}`
          : null,
    };
  });
}

export type VersionContent = Awaited<ReturnType<typeof loadVersionContent>>[number];

/**
 * Content of the given versions, owner-filtered; joined to the question for its decision state.
 */
export async function loadVersionContent(
  db: AnyDb,
  ownerId: string,
  versionIds: string[],
) {
  if (versionIds.length === 0) return [];
  return db
    .select({
      id: questionVersions.id,
      questionId: questionVersions.questionId,
      stemMd: questionVersions.stemMd,
      options: questionVersions.options,
      answer: questionVersions.answer,
      explanationMd: questionVersions.explanationMd,
      steps: questionVersions.steps,
      difficulty: questions.difficulty,
      status: questions.status,
      rowVersion: questions.rowVersion,
      approvalOverride: questions.approvalOverride,
      bankedAt: questions.bankedAt,
      approvedVersionId: questions.approvedVersionId,
      currentVersionId: questions.currentVersionId,
    })
    .from(questionVersions)
    .innerJoin(
      questions,
      and(
        eq(questions.id, questionVersions.questionId),
        eq(questions.ownerId, questionVersions.ownerId),
      ),
    )
    .where(
      and(
        eq(questionVersions.ownerId, ownerId),
        inArray(questionVersions.id, versionIds),
      ),
    );
}

export function toReviewStatus(status: string): ReviewQuestion["verification"]["status"] {
  return (STATUSES as readonly string[]).includes(status)
    ? (status as ReviewQuestion["verification"]["status"])
    : "belum_dapat_diverifikasi";
}

export function projectCurriculum(
  trace: QuestionTrace | undefined,
): RequestReview["curriculum"] {
  const first = trace?.curriculum ?? null;
  return (
    first && {
      versionCode: first.versionCode,
      versionTitle: first.versionTitle,
      elementCode: first.element.code,
      elementName: first.element.name,
      topicTitle: first.topicTitle,
      objectives: first.objectives,
      // The seed's internal notes never reach the teacher (S-16).
      sourceAnchor: teacherSourceAnchor(first.sourceAnchor) ?? null,
    }
  );
}

/**
 * The one place a stored version becomes what the teacher may see. Nothing about models, providers,
 * tokens, prompts or the machine answer leaves this function. Returns null for malformed stored
 * content (skip, never throw).
 */
export function projectReviewQuestion(
  trace: QuestionTrace,
  row: VersionContent | undefined,
): ReviewQuestion | null {
  const parsed = row ? contentSchema.safeParse(row) : null;
  if (!row || !parsed?.success) return null;
  const status = toReviewStatus(trace.verification.status);
  const verdict = trace.verification.crossCheck?.verdict;
  // An approval counts only for the version that was approved: a regeneration moves the current
  // version without touching the status, so an older approval reads as a draft again.
  // Rejection (archived) is about the question and stays rejected.
  const approvalCurrent =
    row.status === "approved" &&
    row.approvedVersionId !== null &&
    row.approvedVersionId === row.currentVersionId;
  const decision: ReviewQuestion["decision"] =
    row.status === "approved"
      ? approvalCurrent
        ? "approved"
        : "draft"
      : (DECISIONS[row.status] ?? "draft");
  return {
    questionId: trace.questionId,
    versionId: trace.versionId,
    versionNo: trace.versionNo,
    rowVersion: row.rowVersion,
    decision,
    override: decision === "approved" && row.approvalOverride != null,
    banked: approvalCurrent && row.bankedAt != null,
    difficulty: (DIFFICULTIES as readonly string[]).includes(row.difficulty)
      ? (row.difficulty as ReviewQuestion["difficulty"])
      : "sedang",
    stemMd: row.stemMd,
    options: parsed.data.options.map((option) => ({
      label: option.label,
      textMd: option.text_md,
    })),
    correctLabel: parsed.data.answer.correctLabel,
    answerDisplayMd: parsed.data.answer.display_md,
    explanationMd: row.explanationMd,
    steps: parsed.data.steps,
    sources: projectSources(trace),
    verification: {
      status,
      checked: trace.verification.verifierVersion !== null,
      checks: projectChecks(trace),
      crossCheck:
        verdict === "agree" || verdict === "disagree" || verdict === "unknown"
          ? verdict
          : null,
      regenerated: trace.versionNo >= 2,
      regenerationFailed: trace.verification.regenerationFailed,
    },
  };
}

/**
 * What the review page may show: the current version's content plus a whitelisted slice of its
 * trace. Nothing about models, providers, tokens, prompts or the machine answer leaves this function.
 */
export async function getRequestReview(
  db: AnyDb,
  input: { ownerId: string; requestId: string },
): Promise<RequestReview | null> {
  const request = (
    await db
      .select({ params: generationRequests.params })
      .from(generationRequests)
      .where(
        and(
          eq(generationRequests.id, input.requestId),
          eq(generationRequests.ownerId, input.ownerId),
        ),
      )
      .limit(1)
  ).at(0);
  if (!request) return null;

  const traces = await getRequestTraces(db, input);
  const content = await loadVersionContent(
    db,
    input.ownerId,
    traces.map((trace) => trace.versionId),
  );

  const reviewQuestions: ReviewQuestion[] = [];
  for (const trace of traces) {
    const projected = projectReviewQuestion(
      trace,
      content.find((candidate) => candidate.id === trace.versionId),
    );
    if (projected) reviewQuestions.push(projected);
  }

  const requestParams = generationParamsSchema.safeParse(request.params);
  return {
    requested: requestParams.success
      ? requestParams.data.quantity
      : reviewQuestions.length,
    curriculum: projectCurriculum(traces[0]),
    questions: reviewQuestions,
  };
}
