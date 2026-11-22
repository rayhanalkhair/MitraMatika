"use server";

import { revalidatePath } from "next/cache";
import { authorizeAction } from "@/features/auth";
import { getDb } from "@/lib/db/runtime";
import { scheduleRun } from "@/lib/jobs/trigger";
import { logger } from "@/lib/logger";
import { getObjectStore } from "@/lib/storage";
import {
  confirmExtractionSchema,
  sessionIdSchema,
  startPhotoSchema,
  textProblemSchema,
  type AlternativeError,
  type ConfirmExtractionError,
  type FinalizePhotoError,
  type SolveAgainError,
  type StartPhotoError,
  type TextSessionError,
} from "../schema/solver";
import type { SolverDb } from "../service/quota";
import {
  confirmExtraction,
  createTextSession,
  finalizePhotoSession,
  requestAlternative,
  solveAgain,
  startPhotoSession,
} from "../service/sessions";

// The solver's Server Actions. Solver rows, jobs and the daily cap are server-written, so these run
// on the service connection with the owner taken from the session, never from the client (bank
// R9). The pages that host them (/solve and /solve/[id]) export maxDuration = 300 for the run
// each one schedules.

type Failure = "invalid" | "unauthenticated" | "generic";
export type SolveTextState =
  { ok: true; sessionId: string } | { ok: false; error: TextSessionError | Failure };
export type StartPhotoState =
  | { ok: true; sessionId: string; uploadUrl: string }
  | { ok: false; error: StartPhotoError | Failure };
export type SessionActionState<E extends string> =
  { ok: true; jobId: string } | { ok: false; error: E | Failure };

const db = () => getDb() as unknown as SolverDb;

function crashed(error: unknown, message: string) {
  logger.error(
    { module: "solver", err: error instanceof Error ? error.name : typeof error },
    message,
  );
  return { ok: false as const, error: "generic" as const };
}

/** Starts the job runner after a run was queued (a status poll or the daily run otherwise). */
function startRunner(sessionId: string) {
  revalidatePath("/solve");
  revalidatePath(`/solve/${sessionId}`);
  try {
    scheduleRun();
  } catch {
    // The status poll of the session page (or the daily run) starts it.
  }
}

/** A typed problem: stored and solved (one solve of today's cap). */
export async function solveTextAction(input: unknown): Promise<SolveTextState> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { ok: false, error: "unauthenticated" };
  const parsed = textProblemSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const result = await createTextSession(db(), {
      ownerId: authorization.data.userId,
      text: parsed.data.text,
      now: new Date(),
    });
    if (!result.ok) return { ok: false, error: result.error };
    startRunner(result.data.sessionId);
    return { ok: true, sessionId: result.data.sessionId };
  } catch (error) {
    return crashed(error, "solver: could not start a typed problem");
  }
}

/** Step 1 of a photo: a PUT URL signed for its exact size and type (the photo never passes here). */
export async function startPhotoAction(input: unknown): Promise<StartPhotoState> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { ok: false, error: "unauthenticated" };
  const parsed = startPhotoSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const result = await startPhotoSession(db(), getObjectStore(), {
      ...parsed.data,
      ownerId: authorization.data.userId,
      now: new Date(),
    });
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, ...result.data };
  } catch (error) {
    return crashed(error, "solver: could not start a photo upload");
  }
}

/** Step 2 of a photo: checks what arrived and queues the reading (one solve of today's cap). */
export async function finalizePhotoAction(
  input: unknown,
): Promise<SessionActionState<FinalizePhotoError>> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { ok: false, error: "unauthenticated" };
  const parsed = sessionIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const result = await finalizePhotoSession(db(), getObjectStore(), {
      ownerId: authorization.data.userId,
      sessionId: parsed.data.sessionId,
      now: new Date(),
    });
    if (!result.ok) return { ok: false, error: result.error };
    startRunner(parsed.data.sessionId);
    return { ok: true, jobId: result.data.jobId };
  } catch (error) {
    return crashed(error, "solver: could not finalise a photo");
  }
}

/** The teacher's confirmed (or corrected) reading of a photo, then the solve (SOL-02). */
export async function confirmExtractionAction(
  input: unknown,
): Promise<SessionActionState<ConfirmExtractionError>> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { ok: false, error: "unauthenticated" };
  const parsed = confirmExtractionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const result = await confirmExtraction(db(), {
      ownerId: authorization.data.userId,
      sessionId: parsed.data.sessionId,
      text: parsed.data.text,
      now: new Date(),
    });
    if (!result.ok) return { ok: false, error: result.error };
    startRunner(parsed.data.sessionId);
    return { ok: true, jobId: result.data.jobId };
  } catch (error) {
    return crashed(error, "solver: could not confirm a reading");
  }
}

/** Solves a session again after its solve failed (one solve of today's cap). */
export async function solveAgainAction(
  input: unknown,
): Promise<SessionActionState<SolveAgainError>> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { ok: false, error: "unauthenticated" };
  const parsed = sessionIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const result = await solveAgain(db(), {
      ownerId: authorization.data.userId,
      sessionId: parsed.data.sessionId,
      now: new Date(),
    });
    if (!result.ok) return { ok: false, error: result.error };
    startRunner(parsed.data.sessionId);
    return { ok: true, jobId: result.data.jobId };
  } catch (error) {
    return crashed(error, "solver: could not solve again");
  }
}

/** "Show another method" (SOL-04; one solve of today's cap). */
export async function requestAlternativeAction(
  input: unknown,
): Promise<SessionActionState<AlternativeError>> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { ok: false, error: "unauthenticated" };
  const parsed = sessionIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const result = await requestAlternative(db(), {
      ownerId: authorization.data.userId,
      sessionId: parsed.data.sessionId,
      now: new Date(),
    });
    if (!result.ok) return { ok: false, error: result.error };
    startRunner(parsed.data.sessionId);
    return { ok: true, jobId: result.data.jobId };
  } catch (error) {
    return crashed(error, "solver: could not ask for another method");
  }
}
