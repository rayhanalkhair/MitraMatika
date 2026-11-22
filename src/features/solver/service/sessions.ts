import "server-only";
// Solver sessions (decision 10): a problem typed by the teacher, or a photo read by the vision
// model and confirmed when uncertain (SOL-02), then solved and verified; "show another method" on
// request (SOL-04). Every row is written on the service connection with explicit owner filters
// (the teacher's role may only read solver rows: a session's status gates solving, its input_key
// names a stored photo and every run counts toward the daily cap). Each request takes the owner's
// solver lock, so the cap and the one-run-at-a-time rule cannot be raced.
import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { jobs, solverSessions, solverSolutions } from "@/lib/db/schema";
import { jpegSize, pngSize } from "@/lib/images/dimensions";
import { stripImageMetadata } from "@/lib/images/strip-metadata";
import { createJobQueue } from "@/lib/jobs/queue";
import { err, ok, type Result } from "@/lib/result";
import { assertAppStorageRoom, lockAppStorage } from "@/lib/storage/app-total";
import type { ObjectStore } from "@/lib/storage/types";
import { fromDbStatus } from "@/features/generation";
import { lockVisionOwner, visionReadsLeft } from "@/features/materials";
import type { VerificationStatus } from "@/features/verification";
import {
  ALTERNATIVE_METHOD_JOB,
  EXTRACT_PROBLEM_JOB,
  MAX_METHODS,
  MAX_PENDING_PHOTOS,
  MAX_PROBLEM_CHARS,
  MAX_SOLVER_PHOTO_BYTES,
  MAX_SOLVER_PHOTO_PIXELS,
  MAX_SOLVER_PHOTO_SIDE,
  PHOTO_READ_PRIORITY,
  PHOTO_FINALIZE_WINDOW_MS,
  PHOTO_UPLOAD_URL_SECONDS,
  RECENT_SESSIONS,
  SOLVE_PROBLEM_JOB,
  SOLVER_JOB_TYPES,
  SOLVER_PHOTO_TYPES,
  USER_DAILY_SOLVES,
  type AlternativeError,
  type ConfirmExtractionError,
  type FinalAnswer,
  type FinalizePhotoError,
  type SolutionStep,
  type SolveAgainError,
  type SolverPhotoMime,
  type StartPhotoError,
  type TextSessionError,
} from "../schema/solver";
import { extractionIssues, MARKER, type ExtractionIssue } from "./issues";
import { mimeOfExt, parseSessionKey, photoKey, photoStagingKey } from "./keys";
import {
  lockSolverOwner,
  readingReachedModel,
  solvesUsedToday,
  type SolverDb,
} from "./quota";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE = ["queued", "running", "deferred"];
const MAX_ATTEMPTS = 3;
const EXCERPT_CHARS = 140;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

interface Owner {
  ownerId: string;
  sessionId: string;
  now: Date;
}

const ofSession = (ownerId: string, sessionId: string) =>
  and(eq(solverSessions.id, sessionId), eq(solverSessions.ownerId, ownerId));
const liveSession = (ownerId: string, sessionId: string) =>
  and(ofSession(ownerId, sessionId), isNull(solverSessions.deletedAt));

/** A problem text as stored: trimmed, not empty, at most MAX_PROBLEM_CHARS. */
function problemText(text: string): Result<string, "empty" | "tooLong"> {
  const trimmed = text.replace(/\r\n?/g, "\n").trim();
  if (trimmed === "") return err("empty");
  if (trimmed.length > MAX_PROBLEM_CHARS) return err("tooLong");
  return ok(trimmed);
}

/** The session's solver jobs that are queued, running or deferred. */
async function liveJobOf(
  db: SolverDb,
  ownerId: string,
  sessionId: string,
): Promise<{ id: string; type: string } | null> {
  const row = (
    await db
      .select({ id: jobs.id, type: jobs.type })
      .from(jobs)
      .where(
        and(
          eq(jobs.ownerId, ownerId),
          inArray(jobs.type, [...SOLVER_JOB_TYPES]),
          inArray(jobs.status, LIVE),
          sql`${jobs.payload}->>'sessionId' = ${sessionId}`,
        ),
      )
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .limit(1)
  ).at(0);
  return row ?? null;
}

async function solutionLabels(
  db: SolverDb,
  ownerId: string,
  sessionId: string,
): Promise<string[]> {
  const rows = await db
    .select({ label: solverSolutions.methodLabel })
    .from(solverSolutions)
    .where(
      and(eq(solverSolutions.sessionId, sessionId), eq(solverSolutions.ownerId, ownerId)),
    )
    .orderBy(asc(solverSolutions.createdAt), asc(solverSolutions.id));
  return rows.map((row) => row.label);
}

function enqueue(
  tx: SolverDb,
  input: {
    ownerId: string;
    type: string;
    payload: unknown;
    now: Date;
    priority?: number;
  },
) {
  return createJobQueue(tx, () => input.now).enqueue({
    ownerId: input.ownerId,
    type: input.type,
    payload: input.payload,
    priority: input.priority,
    // The daily cap counts jobs by created_at against the same clock.
    createdAt: input.now,
    runAfter: input.now,
    maxAttempts: MAX_ATTEMPTS,
  });
}

/** A typed problem: stored as confirmed (the teacher saw it with its preview) and solved. */
export async function createTextSession(
  db: SolverDb,
  input: { ownerId: string; text: string; now: Date },
): Promise<Result<{ sessionId: string; jobId: string }, TextSessionError>> {
  const text = problemText(input.text);
  if (!text.ok) return err(text.error);
  const { ownerId, now } = input;
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as SolverDb;
    await lockSolverOwner(tx, ownerId);
    if ((await solvesUsedToday(tx, ownerId, now)) >= USER_DAILY_SOLVES) {
      return err<TextSessionError>("limit");
    }
    const [session] = await tx
      .insert(solverSessions)
      .values({
        ownerId,
        inputKind: "text",
        inputText: text.data,
        confirmedMd: text.data,
        status: "ready",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: solverSessions.id });
    const job = await enqueue(tx, {
      ownerId,
      type: SOLVE_PROBLEM_JOB,
      payload: { sessionId: session.id, after: 0, counted: true },
      now,
    });
    return ok({ sessionId: session.id, jobId: job.id });
  });
}

/**
 * Step 1 of a photo (camera or gallery): a pending session and a PUT URL signed for the exact size
 * and type, valid for 5 minutes, to the session's staging key. Refused when no solve is left
 * today or when MAX_PENDING_PHOTOS uploads of the last hour were never finished.
 */
export async function startPhotoSession(
  db: SolverDb,
  store: ObjectStore,
  input: {
    ownerId: string;
    kind: "photo" | "file";
    mime: SolverPhotoMime;
    size: number;
    now: Date;
  },
): Promise<Result<{ sessionId: string; uploadUrl: string }, StartPhotoError>> {
  const { ownerId, now } = input;
  if (
    !Number.isSafeInteger(input.size) ||
    input.size < 1 ||
    input.size > MAX_SOLVER_PHOTO_BYTES
  ) {
    throw new RangeError("solver: the photo size is outside the signed range");
  }
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as SolverDb;
    await lockSolverOwner(tx, ownerId);
    if ((await solvesUsedToday(tx, ownerId, now)) >= USER_DAILY_SOLVES) {
      return err<StartPhotoError>("limit");
    }
    // R28: a photo read is one of the day's vision reads, shared with OCR pages (the OCR lock
    // serialises both).
    await lockVisionOwner(tx, ownerId);
    if ((await visionReadsLeft(tx, { ownerId, now })) < 1) {
      return err<StartPhotoError>("visionLimit");
    }
    const [pending] = await tx
      .select({ n: count() })
      .from(solverSessions)
      .where(
        and(
          eq(solverSessions.ownerId, ownerId),
          eq(solverSessions.status, "pending"),
          gt(
            solverSessions.createdAt,
            new Date(now.getTime() - PHOTO_FINALIZE_WINDOW_MS),
          ),
        ),
      );
    if (pending.n >= MAX_PENDING_PHOTOS) return err<StartPhotoError>("pending");
    // The app-wide cap (ADR-0022), last: every owner lock above is held, so the global lock
    // comes second (one fixed order). Held until commit it covers the insert below, whose
    // input_bytes is the declared size (replaced by the real one at finalise).
    await lockAppStorage(tx);
    const room = await assertAppStorageRoom(tx, input.size, "solver");
    if (!room.ok) return err<StartPhotoError>("appFull");
    const sessionId = randomUUID();
    const stagingKey = photoStagingKey(
      ownerId,
      sessionId,
      SOLVER_PHOTO_TYPES[input.mime],
    );
    await tx.insert(solverSessions).values({
      id: sessionId,
      ownerId,
      inputKind: input.kind,
      inputKey: stagingKey,
      inputBytes: input.size,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    const uploadUrl = await store.signedPutUrl(
      stagingKey,
      input.mime,
      input.size,
      PHOTO_UPLOAD_URL_SECONDS,
    );
    return ok({ sessionId, uploadUrl });
  });
}

const startsWith = (bytes: Uint8Array, signature: number[]) =>
  signature.every((byte, i) => bytes[i] === byte);

/** The checks of decision 1 for a photo: the bytes decide, not the name or the declared type. */
function checkPhoto(
  bytes: Uint8Array,
  mime: SolverPhotoMime,
): "type" | "size" | "image" | null {
  if (bytes.length > MAX_SOLVER_PHOTO_BYTES) return "size";
  const isPng = startsWith(bytes, PNG_SIGNATURE);
  const isJpeg = startsWith(bytes, JPEG_SIGNATURE);
  if (mime === "image/png" ? !isPng : !isJpeg) return "type";
  const size = isPng ? pngSize(bytes) : jpegSize(bytes);
  if (
    !size ||
    size.width < 1 ||
    size.height < 1 ||
    size.width > MAX_SOLVER_PHOTO_SIDE ||
    size.height > MAX_SOLVER_PHOTO_SIDE ||
    size.width * size.height > MAX_SOLVER_PHOTO_PIXELS
  ) {
    return "image";
  }
  return null;
}

async function dropPending(
  db: SolverDb,
  store: ObjectStore,
  input: { ownerId: string; sessionId: string; stagingKey: string },
): Promise<void> {
  await store.delete(input.stagingKey);
  await db
    .delete(solverSessions)
    .where(
      and(
        ofSession(input.ownerId, input.sessionId),
        eq(solverSessions.status, "pending"),
      ),
    );
}

/**
 * Step 2 of a photo: the staged bytes are checked (PNG or JPEG magic matching the signed type,
 * size, dimensions; R11 pattern), stripped of their metadata without re-encoding, copied to the
 * session's final key (never signed for a PUT) and
 * the reading is queued (one solve of today's cap). A refused photo is deleted with its session;
 * one that has not arrived yet stays for a retry; another teacher's session is not touched.
 */
export async function finalizePhotoSession(
  db: SolverDb,
  store: ObjectStore,
  input: Owner,
): Promise<Result<{ jobId: string }, FinalizePhotoError>> {
  const { ownerId, sessionId, now } = input;
  if (!UUID.test(sessionId)) return err("notFound");
  const session = (
    await db
      .select({ inputKey: solverSessions.inputKey, createdAt: solverSessions.createdAt })
      .from(solverSessions)
      .where(and(liveSession(ownerId, sessionId), eq(solverSessions.status, "pending")))
      .limit(1)
  ).at(0);
  const staged = parseSessionKey(ownerId, sessionId, session?.inputKey ?? null);
  if (!session || staged?.stage !== "upload") return err("notFound");
  const stagingKey = photoStagingKey(ownerId, sessionId, staged.ext);
  if (now.getTime() - session.createdAt.getTime() > PHOTO_FINALIZE_WINDOW_MS) {
    await dropPending(db, store, { ownerId, sessionId, stagingKey });
    return err("expired");
  }
  const bytes = await store.get(stagingKey);
  if (!bytes) return err("missing");
  const mime = mimeOfExt(staged.ext);
  const refused = checkPhoto(bytes, mime);
  if (refused) {
    await dropPending(db, store, { ownerId, sessionId, stagingKey });
    return err(refused);
  }
  // Exif (GPS, device, time), XMP, IPTC and PNG text chunks never reach storage or the model.
  const clean = stripImageMetadata(bytes, mime);
  if (!clean) {
    await dropPending(db, store, { ownerId, sessionId, stagingKey });
    return err("image");
  }
  const finalKey = photoKey(ownerId, sessionId, staged.ext);
  await store.put(finalKey, clean, mime);
  const outcome = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as SolverDb;
    await lockSolverOwner(tx, ownerId);
    const row = await tx
      .select({ id: solverSessions.id })
      .from(solverSessions)
      .where(
        and(
          liveSession(ownerId, sessionId),
          eq(solverSessions.status, "pending"),
          eq(solverSessions.inputKey, stagingKey),
        ),
      )
      .for("update");
    if (row.length === 0) return err<FinalizePhotoError>("notFound");
    if ((await solvesUsedToday(tx, ownerId, now)) >= USER_DAILY_SOLVES) {
      return err<FinalizePhotoError>("limit");
    }
    await lockVisionOwner(tx, ownerId);
    if ((await visionReadsLeft(tx, { ownerId, now })) < 1) {
      return err<FinalizePhotoError>("visionLimit");
    }
    await tx
      .update(solverSessions)
      .set({
        inputKey: finalKey,
        inputBytes: clean.length,
        status: "extracting",
        updatedAt: now,
      })
      .where(ofSession(ownerId, sessionId));
    const job = await enqueue(tx, {
      ownerId,
      type: EXTRACT_PROBLEM_JOB,
      payload: { sessionId },
      // A teacher waits for this reading: it goes before bulk OCR pages.
      priority: PHOTO_READ_PRIORITY,
      now,
    });
    return ok({ jobId: job.id });
  });
  // Kept only when the reading was queued; a refusal (cap, a lost race) leaves no copy behind.
  await store.delete(outcome.ok ? stagingKey : finalKey);
  return outcome;
}

/**
 * The teacher's confirmation of a photo's text (SOL-02): only a session waiting for it (or whose
 * reading failed) is accepted, and a text that still holds a `[[?]]` marker is refused. The solve
 * that follows belongs to the photo's run, so it does not count again.
 */
export async function confirmExtraction(
  db: SolverDb,
  input: Owner & { text: string },
): Promise<Result<{ jobId: string }, ConfirmExtractionError>> {
  const { ownerId, sessionId, now } = input;
  if (!UUID.test(sessionId)) return err("notFound");
  const text = problemText(input.text);
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as SolverDb;
    await lockSolverOwner(tx, ownerId);
    const session = (
      await tx
        .select({
          status: solverSessions.status,
          inputKind: solverSessions.inputKind,
          confirmedMd: solverSessions.confirmedMd,
        })
        .from(solverSessions)
        .where(liveSession(ownerId, sessionId))
        .for("update")
    ).at(0);
    if (!session) return err<ConfirmExtractionError>("notFound");
    const waiting = session.status === "needs_confirmation";
    const readingFailed =
      session.inputKind !== "text" &&
      session.confirmedMd === null &&
      (session.status === "failed" || session.status === "extracting") &&
      (await liveJobOf(tx, ownerId, sessionId)) === null;
    if (!waiting && !readingFailed) return err<ConfirmExtractionError>("state");
    if (!text.ok) return err<ConfirmExtractionError>(text.error);
    if (text.data.includes(MARKER)) return err<ConfirmExtractionError>("markers");
    // The solve belongs to the photo's run when its reading reached the model today (D1);
    // otherwise this solve is a run of its own and needs a solve left today.
    const counted = !(await readingReachedModel(tx, ownerId, sessionId, now));
    if (counted && (await solvesUsedToday(tx, ownerId, now)) >= USER_DAILY_SOLVES) {
      return err<ConfirmExtractionError>("limit");
    }
    await tx
      .update(solverSessions)
      .set({ confirmedMd: text.data, status: "ready", updatedAt: now })
      .where(ofSession(ownerId, sessionId));
    const job = await enqueue(tx, {
      ownerId,
      type: SOLVE_PROBLEM_JOB,
      payload: { sessionId, after: 0, counted },
      now,
    });
    return ok({ jobId: job.id });
  });
}

/** Solves a session again after its solve failed (or its run died); counts one solve. */
export async function solveAgain(
  db: SolverDb,
  input: Owner,
): Promise<Result<{ jobId: string }, SolveAgainError>> {
  const { ownerId, sessionId, now } = input;
  if (!UUID.test(sessionId)) return err("notFound");
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as SolverDb;
    await lockSolverOwner(tx, ownerId);
    const session = (
      await tx
        .select({
          status: solverSessions.status,
          confirmedMd: solverSessions.confirmedMd,
        })
        .from(solverSessions)
        .where(liveSession(ownerId, sessionId))
        .for("update")
    ).at(0);
    if (!session) return err<SolveAgainError>("notFound");
    if (
      session.confirmedMd === null ||
      (session.status !== "failed" && session.status !== "ready")
    ) {
      return err<SolveAgainError>("state");
    }
    if (await liveJobOf(tx, ownerId, sessionId)) return err<SolveAgainError>("busy");
    if ((await solvesUsedToday(tx, ownerId, now)) >= USER_DAILY_SOLVES) {
      return err<SolveAgainError>("limit");
    }
    const after = (await solutionLabels(tx, ownerId, sessionId)).length;
    await tx
      .update(solverSessions)
      .set({ status: "ready", updatedAt: now })
      .where(ofSession(ownerId, sessionId));
    const job = await enqueue(tx, {
      ownerId,
      type: SOLVE_PROBLEM_JOB,
      payload: { sessionId, after, counted: true },
      now,
    });
    return ok({ jobId: job.id });
  });
}

/**
 * "Show another method" (SOL-04): one solve of today's cap; the job is told every method label
 * shown so far. At most MAX_METHODS methods per session, one run at a time.
 */
export async function requestAlternative(
  db: SolverDb,
  input: Owner,
): Promise<Result<{ jobId: string }, AlternativeError>> {
  const { ownerId, sessionId, now } = input;
  if (!UUID.test(sessionId)) return err("notFound");
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as SolverDb;
    await lockSolverOwner(tx, ownerId);
    const session = (
      await tx
        .select({ status: solverSessions.status })
        .from(solverSessions)
        .where(liveSession(ownerId, sessionId))
        .for("update")
    ).at(0);
    if (!session) return err<AlternativeError>("notFound");
    if (session.status !== "solved") return err<AlternativeError>("state");
    if (await liveJobOf(tx, ownerId, sessionId)) return err<AlternativeError>("busy");
    const labels = await solutionLabels(tx, ownerId, sessionId);
    if (labels.length >= MAX_METHODS) return err<AlternativeError>("noMore");
    if ((await solvesUsedToday(tx, ownerId, now)) >= USER_DAILY_SOLVES) {
      return err<AlternativeError>("limit");
    }
    const job = await enqueue(tx, {
      ownerId,
      type: ALTERNATIVE_METHOD_JOB,
      payload: { sessionId, after: labels.length, excludeMethods: labels },
      now,
    });
    return ok({ jobId: job.id });
  });
}

// ---------------------------------------------------------------------------------------------
// Reads

export type SessionState =
  "pending" | "reading" | "confirm" | "solving" | "solved" | "failed";

export interface SolutionItem {
  id: string;
  methodLabel: string;
  isAlternative: boolean;
  steps: SolutionStep[];
  finalAnswer: FinalAnswer;
  verificationStatus: VerificationStatus;
  /** Whether a passing claim recomputed the final answer from the problem's numbers. */
  answerChecked: boolean;
  /** The independent second solve (R26); null on a solution stored before it existed. */
  crossCheck: "pending" | "agree" | "disagree" | "unavailable" | null;
  /** Its answer, shown when it disagrees. */
  crossCheckAnswer: string | null;
}

export interface SessionView {
  id: string;
  inputKind: "text" | "photo" | "file";
  state: SessionState;
  /** The text the solver works on (typed, or confirmed). */
  problemMd: string | null;
  /** What the vision model read, and why it must be checked. */
  extractedMd: string | null;
  issues: ExtractionIssue[];
  /** The photo is still stored (deleted 7 days after the session started). */
  hasPhoto: boolean;
  createdAt: string;
  solutions: SolutionItem[];
  /** The run to follow while one is live. */
  jobId: string | null;
  working: "extract" | "solve" | "alternative" | null;
  /** The failure code of the newest run when it failed. */
  failureCode: string | null;
  alternativeFailed: boolean;
  canSolveAgain: boolean;
  canAlternative: boolean;
}

function asSteps(value: unknown): SolutionStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((step: unknown) => {
    const s = step as { title?: unknown; bodyMd?: unknown } | null;
    return typeof s?.bodyMd === "string"
      ? [{ title: typeof s.title === "string" ? s.title : null, bodyMd: s.bodyMd }]
      : [];
  });
}

function asFinalAnswer(value: unknown): FinalAnswer {
  const v = value as { value?: unknown; unit?: unknown; rounding?: unknown } | null;
  return {
    value: typeof v?.value === "string" ? v.value : "",
    unit: typeof v?.unit === "string" ? v.unit : null,
    rounding: typeof v?.rounding === "string" ? v.rounding : null,
  };
}

const CROSS_CHECKS = ["pending", "agree", "disagree", "unavailable"] as const;

/** What the badge needs from a stored verification report. */
function reportFields(
  value: unknown,
): Pick<SolutionItem, "answerChecked" | "crossCheck" | "crossCheckAnswer"> {
  const report = value as {
    answerChecked?: unknown;
    crossCheck?: unknown;
    crossCheckAnswer?: unknown;
  } | null;
  const crossCheck = CROSS_CHECKS.find((name) => name === report?.crossCheck) ?? null;
  return {
    answerChecked: report?.answerChecked === true,
    crossCheck,
    crossCheckAnswer:
      typeof report?.crossCheckAnswer === "string" ? report.crossCheckAnswer : null,
  };
}

const KIND_OF_JOB = {
  [EXTRACT_PROBLEM_JOB]: "extract",
  [SOLVE_PROBLEM_JOB]: "solve",
  [ALTERNATIVE_METHOD_JOB]: "alternative",
} as const;

/** One of the owner's live sessions with its solutions and its newest run; null otherwise. */
export async function getSession(
  db: SolverDb,
  input: { ownerId: string; sessionId: string },
): Promise<SessionView | null> {
  const { ownerId, sessionId } = input;
  if (!UUID.test(sessionId)) return null;
  const session = (
    await db.select().from(solverSessions).where(liveSession(ownerId, sessionId)).limit(1)
  ).at(0);
  if (!session) return null;
  const solutions = await db
    .select()
    .from(solverSolutions)
    .where(
      and(eq(solverSolutions.sessionId, sessionId), eq(solverSolutions.ownerId, ownerId)),
    )
    .orderBy(asc(solverSolutions.createdAt), asc(solverSolutions.id));
  const newest = (
    await db
      .select({ id: jobs.id, type: jobs.type, status: jobs.status, error: jobs.error })
      .from(jobs)
      .where(
        and(
          eq(jobs.ownerId, ownerId),
          inArray(jobs.type, [...SOLVER_JOB_TYPES]),
          sql`${jobs.payload}->>'sessionId' = ${sessionId}`,
        ),
      )
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .limit(1)
  ).at(0);
  const live = newest !== undefined && LIVE.includes(newest.status);
  const working = live ? KIND_OF_JOB[newest.type as keyof typeof KIND_OF_JOB] : null;
  const code = (newest?.error as { code?: unknown } | null | undefined)?.code;
  const newestFailed = newest?.status === "failed";

  let state: SessionState;
  if (session.status === "pending") state = "pending";
  else if (working === "extract") state = "reading";
  else if (working === "solve") state = "solving";
  else if (session.status === "needs_confirmation") state = "confirm";
  else if (session.status === "solved") state = "solved";
  // Failed, or a run that died without saying so (extracting/ready with no live job).
  else state = "failed";

  const flags = Array.isArray(session.extractionFlags)
    ? session.extractionFlags.filter((flag): flag is string => typeof flag === "string")
    : [];
  const hasPhoto =
    parseSessionKey(ownerId, sessionId, session.inputKey)?.stage === "photo";
  return {
    id: session.id,
    inputKind: session.inputKind as SessionView["inputKind"],
    state,
    problemMd: session.confirmedMd,
    extractedMd: session.extractedMd,
    issues:
      session.extractedMd === null && session.inputKind === "text"
        ? []
        : extractionIssues(session.extractedMd, flags),
    hasPhoto,
    createdAt: session.createdAt.toISOString(),
    solutions: solutions.map((row) => ({
      id: row.id,
      methodLabel: row.methodLabel,
      isAlternative: row.isAlternative,
      steps: asSteps(row.steps),
      finalAnswer: asFinalAnswer(row.finalAnswer),
      verificationStatus: fromDbStatus(row.verificationStatus) as VerificationStatus,
      ...reportFields(row.verificationReport),
    })),
    jobId: live ? newest.id : null,
    working,
    failureCode: newestFailed && typeof code === "string" ? code : null,
    alternativeFailed: newestFailed && newest.type === ALTERNATIVE_METHOD_JOB,
    canSolveAgain: state === "failed" && session.confirmedMd !== null,
    canAlternative:
      state === "solved" && working === null && solutions.length < MAX_METHODS,
  };
}

export interface RecentSession {
  id: string;
  inputKind: "text" | "photo" | "file";
  status: string;
  excerptMd: string;
  createdAt: string;
  /** The newest solution's verification, or null before the first one. */
  verificationStatus: VerificationStatus | null;
}

/** A short excerpt that never ends inside an inline formula. */
export function problemExcerpt(text: string): string {
  const flat = text.split(MARKER).join("").replace(/\s+/g, " ").trim();
  if (flat.length <= EXCERPT_CHARS) return flat;
  let cut = flat.slice(0, EXCERPT_CHARS);
  const space = cut.lastIndexOf(" ");
  if (space > EXCERPT_CHARS / 2) cut = cut.slice(0, space);
  if ((cut.match(/\$/g) ?? []).length % 2 === 1) cut = cut.slice(0, cut.lastIndexOf("$"));
  return `${cut.trimEnd()}…`;
}

/** The owner's newest RECENT_SESSIONS sessions (decision 10), without trashed or unsent ones. */
export async function listRecentSessions(
  db: SolverDb,
  input: { ownerId: string },
): Promise<RecentSession[]> {
  const latestStatus = sql<string | null>`(select ${solverSolutions.verificationStatus}
    from ${solverSolutions}
    where ${solverSolutions.sessionId} = ${solverSessions.id}
      and ${solverSolutions.ownerId} = ${solverSessions.ownerId}
    order by ${solverSolutions.createdAt} desc, ${solverSolutions.id} desc limit 1)`;
  const liveRun = sql<boolean>`exists (select 1 from ${jobs}
    where ${jobs.ownerId} = ${solverSessions.ownerId}
      and ${inArray(jobs.type, [...SOLVER_JOB_TYPES])}
      and ${inArray(jobs.status, LIVE)}
      and ${jobs.payload}->>'sessionId' = ${solverSessions.id}::text)`;
  const rows = await db
    .select({
      id: solverSessions.id,
      inputKind: solverSessions.inputKind,
      status: solverSessions.status,
      live: liveRun,
      confirmedMd: solverSessions.confirmedMd,
      extractedMd: solverSessions.extractedMd,
      inputText: solverSessions.inputText,
      createdAt: solverSessions.createdAt,
      verificationStatus: latestStatus,
    })
    .from(solverSessions)
    .where(
      and(
        eq(solverSessions.ownerId, input.ownerId),
        isNull(solverSessions.deletedAt),
        ne(solverSessions.status, "pending"),
      ),
    )
    .orderBy(desc(solverSessions.createdAt), desc(solverSessions.id))
    .limit(RECENT_SESSIONS);
  return rows.map((row) => ({
    id: row.id,
    inputKind: row.inputKind as RecentSession["inputKind"],
    // Reading or solving with no live run: the run died (as on the session page).
    status:
      (row.status === "extracting" || row.status === "ready") && !row.live
        ? "failed"
        : row.status,
    excerptMd: problemExcerpt(row.confirmedMd ?? row.extractedMd ?? row.inputText ?? ""),
    createdAt: row.createdAt.toISOString(),
    verificationStatus:
      row.verificationStatus === null
        ? null
        : (fromDbStatus(row.verificationStatus) as VerificationStatus),
  }));
}
