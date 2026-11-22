// The trash for solver sessions (decision 10: sessions can be trashed; 30 days, restore, purge).
// Writes on the service connection naming owner_id in every statement (the teacher's role may only
// read solver rows); the list under runAsUser (the page). Trashing cancels the session's runs that
// have not started; a running one finds the session trashed and stores nothing.
//
// Deleting for good removes the session and its solutions (cascade), logs ids and counts in
// deletion_log, and deletes the session's whole own prefix `solver/<ownerId>/<sessionId>/` LAST,
// under the row lock inside the same transaction (R13: never the raw input_key column). A storage
// failure rolls the rows back, so a photo is never left behind without its row; the 7-day photo
// sweep (solver/service/photos.ts) is the other way photos go.
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  sql,
} from "drizzle-orm";
import { deletionLog, jobs, solverSessions, solverSolutions } from "@/lib/db/schema";
import type { AnyDb } from "@/features/generation";
import { logger } from "@/lib/logger";
import { err, ok, type Result } from "@/lib/result";
import type { StoreSource } from "./assessment-trash";
import { safeErrorSummary } from "./error-summary";
import { daysLeft, purgeAfterFrom, type TrashFailure } from "./retention";
import { SOLVER_JOB_TYPES, solverSessionPrefix } from "./storage-keys";

export const DELETION_ENTITY_SOLVER_SESSION = "solver_session";
const PURGE_BATCH = 200;
const NOT_STARTED = ["queued", "deferred"];
const EXCERPT_CHARS = 140;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface SolverSessionPurgeCounts {
  solutions: number;
  /** Objects removed under the session's own prefix (its photo). */
  files: number;
}

const ofSession = (ownerId: string, sessionId: string) =>
  and(eq(solverSessions.id, sessionId), eq(solverSessions.ownerId, ownerId));

async function ownsSession(db: AnyDb, ownerId: string, sessionId: string) {
  const rows = await db
    .select({ id: solverSessions.id })
    .from(solverSessions)
    .where(ofSession(ownerId, sessionId))
    .limit(1);
  return rows.length > 0;
}

/** Cancels the session's solver runs that have not started. */
async function cancelSessionJobs(
  db: AnyDb,
  input: { ownerId: string; sessionId: string; now: Date },
): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "cancelled", updatedAt: input.now })
    .where(
      and(
        eq(jobs.ownerId, input.ownerId),
        inArray(jobs.type, SOLVER_JOB_TYPES),
        inArray(jobs.status, NOT_STARTED),
        sql`${jobs.payload}->>'sessionId' = ${input.sessionId}`,
      ),
    );
}

/**
 * Moves one of the owner's sessions to the trash for 30 days. Unknown, foreign or already trashed
 * ids are notFound.
 */
export async function trashSolverSession(
  db: AnyDb,
  input: { ownerId: string; sessionId: string; now: Date },
): Promise<Result<void, TrashFailure>> {
  const { ownerId, sessionId, now } = input;
  if (!UUID.test(sessionId)) return err("notFound");
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(solverSessions)
      .set({ deletedAt: now, purgeAfter: purgeAfterFrom(now) })
      .where(and(ofSession(ownerId, sessionId), isNull(solverSessions.deletedAt)))
      .returning({ id: solverSessions.id });
    if (updated.length === 0) return err<TrashFailure>("notFound");
    await cancelSessionJobs(tx, { ownerId, sessionId, now });
    return ok();
  });
}

/**
 * Takes a session out of the trash as it was. A run that was cancelled by the trash shows as
 * failed, and the teacher can solve again. One guarded UPDATE: a purge waiting on the row lock
 * re-checks deleted_at and skips it.
 */
export async function restoreSolverSession(
  db: AnyDb,
  input: { ownerId: string; sessionId: string },
): Promise<Result<void, TrashFailure>> {
  const { ownerId, sessionId } = input;
  if (!UUID.test(sessionId)) return err("notFound");
  const updated = await db
    .update(solverSessions)
    .set({ deletedAt: null, purgeAfter: null })
    .where(and(ofSession(ownerId, sessionId), isNotNull(solverSessions.deletedAt)))
    .returning({ id: solverSessions.id });
  if (updated.length > 0) return ok();
  return err((await ownsSession(db, ownerId, sessionId)) ? "notInTrash" : "notFound");
}

/**
 * Deletes one trashed session in one transaction, guarded under the row lock (in the trash; past
 * purge_after when `expiredBy` is given; this owner when `ownerId` is given). Returns the counts,
 * or null when the guard did not hold (nothing written).
 */
export async function purgeSolverSession(
  db: AnyDb,
  store: StoreSource,
  input: { sessionId: string; ownerId?: string; expiredBy?: Date; now: Date },
): Promise<SolverSessionPurgeCounts | null> {
  const { sessionId, now } = input;
  if (!UUID.test(sessionId)) return null;
  return db.transaction(async (tx) => {
    const locked = (
      await tx
        .select({ ownerId: solverSessions.ownerId })
        .from(solverSessions)
        .where(
          and(
            eq(solverSessions.id, sessionId),
            isNotNull(solverSessions.deletedAt),
            input.ownerId === undefined
              ? undefined
              : eq(solverSessions.ownerId, input.ownerId),
            input.expiredBy === undefined
              ? undefined
              : lte(solverSessions.purgeAfter, input.expiredBy),
          ),
        )
        .for("update")
    ).at(0);
    if (!locked) return null;
    const { ownerId } = locked;
    const [solutions] = await tx
      .select({ n: count() })
      .from(solverSolutions)
      .where(
        and(
          eq(solverSolutions.sessionId, sessionId),
          eq(solverSolutions.ownerId, ownerId),
        ),
      );
    await cancelSessionJobs(tx, { ownerId, sessionId, now });
    // Database first; the cascade takes the solutions.
    await tx.delete(solverSessions).where(ofSession(ownerId, sessionId));
    await tx.insert(deletionLog).values({
      ownerId,
      entity: DELETION_ENTITY_SOLVER_SESSION,
      entityId: sessionId,
      counts: { sessions: 1, solutions: solutions.n },
      deletedAt: now,
    });
    // Storage last, the session's whole own prefix whatever its column says (R13).
    const files = await store().deletePrefix(solverSessionPrefix(ownerId, sessionId));
    return { solutions: solutions.n, files };
  });
}

/** The teacher's "delete for good": refused when not in the trash. */
export async function deleteSolverSessionPermanently(
  db: AnyDb,
  store: StoreSource,
  input: { ownerId: string; sessionId: string; now: Date },
): Promise<Result<SolverSessionPurgeCounts, TrashFailure>> {
  const { ownerId, sessionId, now } = input;
  const outcome = await purgeSolverSession(db, store, { sessionId, ownerId, now });
  if (outcome) return ok(outcome);
  return err((await ownsSession(db, ownerId, sessionId)) ? "notInTrash" : "notFound");
}

/**
 * Deletes every expired trashed session of every owner, each in its own guarded transaction: one
 * that fails is rolled back, logged and retried the next day; no new row once out of time.
 */
export async function purgeExpiredSolverSessions(
  db: AnyDb,
  store: StoreSource,
  now: Date,
  options: { batch?: number; outOfTime?: () => boolean; skip?: Set<string> } = {},
): Promise<{ purged: number; failed: number }> {
  const candidates = await db
    .select({ id: solverSessions.id })
    .from(solverSessions)
    .where(and(isNotNull(solverSessions.deletedAt), lte(solverSessions.purgeAfter, now)))
    .orderBy(asc(solverSessions.purgeAfter), asc(solverSessions.id))
    .limit(options.batch ?? PURGE_BATCH);
  let purged = 0;
  let failed = 0;
  for (const { id } of candidates) {
    // A row that already failed in this run is not tried again before the others (R31).
    if (options.skip?.has(id)) continue;
    if (options.outOfTime?.()) break;
    try {
      const outcome = await purgeSolverSession(db, store, {
        sessionId: id,
        expiredBy: now,
        now,
      });
      if (outcome) purged += 1;
    } catch (error) {
      failed += 1;
      options.skip?.add(id);
      logger.error(
        { module: "trash", sessionId: id, err: safeErrorSummary(error) },
        "trash: could not purge a solver session",
      );
    }
  }
  return { purged, failed };
}

export interface TrashedSolverSession {
  sessionId: string;
  excerptMd: string;
  solutionCount: number;
  /** Its photo is still stored (deleted 7 days after the session anyway). */
  hasPhoto: boolean;
  deletedAt: string;
  purgeAfter: string;
  daysLeft: number;
}

function excerpt(text: string): string {
  const flat = text.split("[[?]]").join("").replace(/\s+/g, " ").trim();
  if (flat.length <= EXCERPT_CHARS) return flat;
  let cut = flat.slice(0, EXCERPT_CHARS);
  if ((cut.match(/\$/g) ?? []).length % 2 === 1) cut = cut.slice(0, cut.lastIndexOf("$"));
  return `${cut.trimEnd()}…`;
}

/** The owner's trashed sessions, most recently deleted first. */
export async function listTrashedSolverSessions(
  db: AnyDb,
  input: { ownerId: string; now: Date },
): Promise<TrashedSolverSession[]> {
  const { ownerId, now } = input;
  const rows = await db
    .select({
      id: solverSessions.id,
      confirmedMd: solverSessions.confirmedMd,
      extractedMd: solverSessions.extractedMd,
      inputText: solverSessions.inputText,
      inputKey: solverSessions.inputKey,
      deletedAt: solverSessions.deletedAt,
      purgeAfter: solverSessions.purgeAfter,
    })
    .from(solverSessions)
    .where(and(eq(solverSessions.ownerId, ownerId), isNotNull(solverSessions.deletedAt)))
    .orderBy(desc(solverSessions.deletedAt), asc(solverSessions.id));
  if (rows.length === 0) return [];
  const solutions = await db
    .select({ sessionId: solverSolutions.sessionId, n: count() })
    .from(solverSolutions)
    .where(
      and(
        eq(solverSolutions.ownerId, ownerId),
        inArray(
          solverSolutions.sessionId,
          rows.map((row) => row.id),
        ),
      ),
    )
    .groupBy(solverSolutions.sessionId);
  return rows.flatMap((row) => {
    if (!row.deletedAt || !row.purgeAfter) return [];
    return [
      {
        sessionId: row.id,
        excerptMd: excerpt(row.confirmedMd ?? row.extractedMd ?? row.inputText ?? ""),
        solutionCount: solutions.find((s) => s.sessionId === row.id)?.n ?? 0,
        hasPhoto: row.inputKey !== null,
        deletedAt: row.deletedAt.toISOString(),
        purgeAfter: row.purgeAfter.toISOString(),
        daysLeft: daysLeft(row.purgeAfter, now),
      },
    ];
  });
}
