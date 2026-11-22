// The one place the approve / reject / reset rules are written down. The server re-derives every
// fact it trusts (ownership, version, row version, effective verification status, job state); the
// caller applies `runAsUser`, so every statement below also runs under RLS. Each statement names
// owner_id as well, because the service connection does not enforce RLS.
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  generationRequests,
  jobs,
  questions,
  questionVersions,
  verificationRuns,
} from "@/lib/db/schema";
import { err, ok, type Result } from "@/lib/result";
import type { AnyDb } from "@/features/generation";
import {
  findPendingRegeneration,
  fromDbStatus,
  hasCitationFailure,
  isRegenerationMarker,
} from "@/features/generation";

export const OVERRIDE_NOTE_MIN = 10;
export const OVERRIDE_NOTE_MAX = 500;

export type DecisionAction = "approve" | "reject" | "reset";
export type Decision = "draft" | "approved" | "rejected";
export interface DecisionSuccess {
  decision: Decision;
  rowVersion: number;
  override: boolean;
  versionNo: number;
}
export type DecisionFailure =
  | "not_found"
  | "already_saved"
  | "conflict"
  | "override_required"
  | "invalid_note"
  | "not_ready";
export type DecisionResult = Result<DecisionSuccess, DecisionFailure>;

// Same terminal set as src/lib/jobs/client/status.ts (isTerminal).
const TERMINAL_JOB_STATUSES = ["succeeded", "failed", "cancelled"];

/**
 * The approve / reject / reset rules. Re-derives ownership, version, row version, effective
 * verification status and job state on the server; every statement names `owner_id` as well
 * (the caller should pass a `runAsUser` transaction). Expected refusals come back as
 * `err(DecisionFailure)`; the guarded UPDATE is the optimistic lock (`conflict`).
 */
export async function decideQuestion(
  db: AnyDb,
  input: {
    ownerId: string;
    questionId: string;
    versionId: string;
    rowVersion: number;
    action: DecisionAction;
    overrideNote?: string;
    now: Date;
  },
): Promise<DecisionResult> {
  const { ownerId, questionId, versionId, action } = input;

  // 1. Load the question, owner-filtered; a question in the trash is not found.
  const question = (
    await db
      .select({
        currentVersionId: questions.currentVersionId,
        rowVersion: questions.rowVersion,
        generationRequestId: questions.generationRequestId,
        bankedAt: questions.bankedAt,
      })
      .from(questions)
      .where(
        and(
          eq(questions.id, questionId),
          eq(questions.ownerId, ownerId),
          isNull(questions.deletedAt),
        ),
      )
      .limit(1)
  ).at(0);
  if (!question) return err("not_found");

  // A question saved to the Bank Soal is locked: no approve, reject or reset.
  if (question.bankedAt !== null) return err("already_saved");

  // 2. A stale click: another version or another row version than the one the teacher saw.
  if (
    question.currentVersionId !== versionId ||
    question.rowVersion !== input.rowVersion
  ) {
    return err("conflict");
  }
  const version = (
    await db
      .select({
        versionNo: questionVersions.versionNo,
        verificationStatus: questionVersions.verificationStatus,
      })
      .from(questionVersions)
      .where(
        and(
          eq(questionVersions.id, versionId),
          eq(questionVersions.questionId, questionId),
          eq(questionVersions.ownerId, ownerId),
        ),
      )
      .limit(1)
  ).at(0);
  if (!version) return err("not_found");

  let override: { note: string; versionId: string; at: string } | null = null;

  if (action === "approve") {
    // 3. Effective status: the latest real (non-marker) run, else the stored creation value.
    const runs = await db
      .select({
        status: verificationRuns.status,
        checks: verificationRuns.checks,
        crossCheck: verificationRuns.crossCheck,
      })
      .from(verificationRuns)
      .where(
        and(
          eq(verificationRuns.questionVersionId, versionId),
          eq(verificationRuns.ownerId, ownerId),
        ),
      )
      .orderBy(asc(verificationRuns.createdAt), asc(verificationRuns.id));
    const real = runs.filter((run) => !isRegenerationMarker(run.crossCheck));
    const latest = real.at(-1);
    const hasRun = latest !== undefined;
    const status = fromDbStatus(latest ? latest.status : version.verificationStatus);

    // 4. The job must be finished for checks that have not run, and for a first-version
    // contradiction the pipeline may still regenerate (a note written now would be thrown away).
    const hasMarker = runs.some((run) => isRegenerationMarker(run.crossCheck));
    // Rejected material citations are regenerated the same way (Task 7): approving now would
    // approve a version the pipeline is about to replace.
    const pipelineMayRegenerate =
      (status === "ketidaksesuaian" || hasCitationFailure(latest ?? null)) &&
      !hasMarker &&
      version.versionNo === 1;
    if (!hasRun || pipelineMayRegenerate) {
      let terminal = true; // a missing request, job link or job counts as terminal
      if (question.generationRequestId) {
        const job = (
          await db
            .select({ status: jobs.status })
            .from(generationRequests)
            .innerJoin(
              jobs,
              and(eq(jobs.id, generationRequests.jobId), eq(jobs.ownerId, ownerId)),
            )
            .where(
              and(
                eq(generationRequests.id, question.generationRequestId),
                eq(generationRequests.ownerId, ownerId),
              ),
            )
            .limit(1)
        ).at(0);
        if (job) terminal = TERMINAL_JOB_STATUSES.includes(job.status);
      }
      // A teacher's regeneration of this question has not verified its new version yet.
      if (terminal && !hasRun) {
        terminal = (await findPendingRegeneration(db, { ownerId, questionId })) === null;
      }
      if (!terminal) return err("not_ready");
    }

    if (status === "ketidaksesuaian") {
      if (input.overrideNote === undefined) return err("override_required");
      const note = input.overrideNote.trim();
      if (note.length < OVERRIDE_NOTE_MIN || note.length > OVERRIDE_NOTE_MAX) {
        return err("invalid_note");
      }
      override = { note, versionId, at: input.now.toISOString() };
    }
  }

  // 5. Guarded update: the row version in the WHERE clause is the optimistic lock.
  const values =
    action === "approve"
      ? {
          status: "approved",
          approvedVersionId: versionId,
          approvedAt: input.now,
          approvalOverride: override,
        }
      : {
          status: action === "reject" ? "archived" : "draft",
          approvedVersionId: null,
          approvedAt: null,
          approvalOverride: null,
        };
  const updated = await db
    .update(questions)
    .set({
      ...values,
      rowVersion: sql`${questions.rowVersion} + 1`,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(questions.id, questionId),
        eq(questions.ownerId, ownerId),
        eq(questions.rowVersion, input.rowVersion),
        // A regeneration moves current_version_id without bumping row_version.
        eq(questions.currentVersionId, versionId),
        // A save to the bank between the read and this update does not change row_version.
        isNull(questions.bankedAt),
        // Nor does a move to the trash.
        isNull(questions.deletedAt),
      ),
    )
    .returning({ id: questions.id });
  if (updated.length === 0) return err("conflict");

  // 6.
  return ok({
    decision:
      action === "approve" ? "approved" : action === "reject" ? "rejected" : "draft",
    rowVersion: input.rowVersion + 1,
    override: override !== null,
    versionNo: version.versionNo,
  });
}
