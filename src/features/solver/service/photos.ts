import "server-only";
// Solver photos are deleted from storage 7 days after their session started (decision 10), by the
// daily jobs run: every session (trashed or not, any owner) whose input_key is still set and
// that started PHOTO_RETENTION_MS ago has its whole own prefix `solver/<ownerId>/<sessionId>/`
// deleted (ids only, R13: never the raw column), then input_key cleared; the session keeps its
// text and solutions. An upload that was never finished (still `pending`) has nothing else to
// keep, so its row goes too. Each row on its own (a failure is logged, counted and retried the
// next run, after the rows not tried yet: photo_sweep_attempted_at), every store call bounded,
// and no new row after the time budget. The 7 days run from created_at, never updated_at.
import { and, asc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { solverSessions } from "@/lib/db/schema";
import { getDb } from "@/lib/db/runtime";
import { logger } from "@/lib/logger";
import { stepBudgetMs, type StepReport } from "@/lib/jobs/tick";
import { getObjectStore } from "@/lib/storage";
import { boundObjectStore } from "@/lib/storage/bounded";
import type { ObjectStore } from "@/lib/storage/types";
import { PHOTO_RETENTION_MS } from "../schema/solver";
import { sessionPrefix } from "./keys";
import type { SolverDb } from "./quota";

const PHOTO_BATCH = 200;
/** The whole solver housekeeping takes no new row after this long. */
export const SOLVER_SWEEP_BUDGET_MS = 15_000;
/** One store call of the sweep may take at most this long. */
const STORE_CALL_TIMEOUT_MS = 10_000;

function errorSummary(error: unknown) {
  const outer = error as
    { code?: unknown; cause?: { code?: unknown } } | null | undefined;
  const code = outer?.code ?? outer?.cause?.code;
  return {
    name: error instanceof Error ? error.name : typeof error,
    code: typeof code === "string" ? code : null,
  };
}

/** Deletes the photos of sessions older than 7 days; returns the counts. Idempotent. */
export async function sweepSolverPhotos(
  db: SolverDb,
  store: ObjectStore,
  now: Date,
  options: { batch?: number; outOfTime?: () => boolean } = {},
): Promise<{ deleted: number; failed: number }> {
  const cutoff = new Date(now.getTime() - PHOTO_RETENTION_MS);
  const expired = and(
    isNotNull(solverSessions.inputKey),
    lte(solverSessions.createdAt, cutoff),
  );
  // The partial index solver_sessions_photo_purge_idx (created_at where input_key is not null).
  const rows = await db
    .select({
      id: solverSessions.id,
      ownerId: solverSessions.ownerId,
      status: solverSessions.status,
    })
    .from(solverSessions)
    .where(expired)
    // The least recently tried first (never updated_at, which the teacher's actions move): a row
    // that keeps failing goes to the back.
    .orderBy(
      asc(
        sql`coalesce(${solverSessions.photoSweepAttemptedAt}, ${solverSessions.createdAt})`,
      ),
      asc(solverSessions.id),
    )
    .limit(options.batch ?? PHOTO_BATCH);
  let deleted = 0;
  let failed = 0;
  for (const row of rows) {
    if (options.outOfTime?.()) break;
    try {
      await store.deletePrefix(sessionPrefix(row.ownerId, row.id));
      const ofRow = and(
        eq(solverSessions.id, row.id),
        eq(solverSessions.ownerId, row.ownerId),
        expired,
      );
      const gone =
        row.status === "pending"
          ? await db
              .delete(solverSessions)
              .where(and(ofRow, eq(solverSessions.status, "pending")))
              .returning({ id: solverSessions.id })
          : await db
              .update(solverSessions)
              .set({ inputKey: null })
              .where(ofRow)
              .returning({ id: solverSessions.id });
      deleted += gone.length;
    } catch (error) {
      failed += 1;
      logger.error(
        { module: "solver", sessionId: row.id, err: errorSummary(error) },
        "solver: could not delete an expired photo",
      );
      try {
        await db
          .update(solverSessions)
          .set({ photoSweepAttemptedAt: now })
          .where(
            and(eq(solverSessions.id, row.id), eq(solverSessions.ownerId, row.ownerId)),
          );
      } catch {
        // Ordering only: the row is tried again on the next run either way.
      }
    }
  }
  return { deleted, failed };
}

/** The solver's share of the daily run, bounded in time; never throws. */
export async function runSolverHousekeeping(
  db: SolverDb,
  store: () => ObjectStore,
  now: Date,
  options: {
    budgetMs?: number;
    clock?: () => number;
    /** Called when the budget stopped the sweep with photos left. */
    onBacklog?: () => void;
    /** Called when the sweep failed (already logged). */
    onFailure?: () => void;
  } = {},
): Promise<{ photos: { deleted: number; failed: number } }> {
  const clock = options.clock ?? Date.now;
  const started = clock();
  const budgetMs = options.budgetMs ?? SOLVER_SWEEP_BUDGET_MS;
  let photos = { deleted: 0, failed: 0 };
  try {
    photos = await sweepSolverPhotos(
      db,
      boundObjectStore(store(), STORE_CALL_TIMEOUT_MS),
      now,
      {
        outOfTime: () => {
          const late = clock() - started >= budgetMs;
          if (late) options.onBacklog?.();
          return late;
        },
      },
    );
  } catch (error) {
    logger.error(
      { module: "solver", err: errorSummary(error) },
      "solver: the photo sweep failed",
    );
    options.onFailure?.();
  }
  return { photos };
}

/** The daily run's step (service connection). Never throws; reports a failure and a backlog. */
export async function sweepSolver(
  now: Date = new Date(),
  remainingMs?: number,
): Promise<StepReport> {
  const report: StepReport = {};
  const result = await runSolverHousekeeping(getDb(), getObjectStore, now, {
    budgetMs: stepBudgetMs(SOLVER_SWEEP_BUDGET_MS, remainingMs),
    onBacklog: () => {
      report.backlogLeft = true;
    },
    onFailure: () => {
      report.failed = true;
    },
  });
  if (result.photos.deleted > 0 || result.photos.failed > 0) {
    logger.info({ module: "solver", ...result }, "solver: housekeeping done");
  }
  return report;
}
