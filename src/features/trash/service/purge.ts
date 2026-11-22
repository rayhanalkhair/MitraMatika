// Permanent deletion of trashed questions: the 30-day purge (all owners, service connection) and
// the teacher's "delete permanently" share purgeQuestion.
//
// question_versions rows are immutable: a trigger rejects every UPDATE, and no role but the service
// connection may DELETE them. The only sanctioned way a version goes is with its question: deleting
// the question row cascades to its versions (question_versions_question_owner_fk) and from them to
// their verification runs and curriculum sources. Answer rules live inside the version row. Nothing
// here updates or deletes a version directly.
//
// Ruling R2: a question pinned by an assessment item (the assessment trashed or not) never goes
// for good while the assessment exists: the purge skips it (logged with ids and a count) and the
// teacher's delete is refused with the titles of the assessments. The item's foreign key (NO
// ACTION) is the backstop.
import {
  and,
  asc,
  count,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  lte,
  not,
  sql,
} from "drizzle-orm";
import {
  assessmentItems,
  assessments,
  auditLog,
  deletionLog,
  jobs,
  questions,
  questionSources,
  questionVersions,
  verificationRuns,
} from "@/lib/db/schema";
import {
  findPendingRegeneration,
  REGENERATE_JOB_TYPE,
  settleRegenerationApproval,
  type AnyDb,
} from "@/features/generation";
import { logger } from "@/lib/logger";
import { purgeExpiredAssessments, type StoreSource } from "./assessment-trash";
import { boundedStore } from "./bounded-store";
import { safeErrorSummary } from "./error-summary";
import type { InUse } from "./retention";
import { purgeExpiredFolders, purgeExpiredMaterials } from "./material-trash";
import { purgeExpiredSolverSessions } from "./solver-trash";
import { purgeExpiredTemplates } from "./template-trash";

export interface PurgeCounts {
  versions: number;
  verificationRuns: number;
  sources: number;
}

export const DELETION_ENTITY_QUESTION = "question";
// The marker of one daily purge (audit_log, no owner): at most one run per Asia/Jakarta day.
export const AUDIT_TRASH_PURGED = "trash_purged";
// One run deletes at most this many questions; the rest go the next day.
const PURGE_BATCH = 500;
const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * The kinds the daily purge deletes. A template or a question that an assessment pins is skipped
 * until that assessment is gone, so assessments always go first, then templates and questions
 * (a fixed prefix). Materials, folders and solver sessions do not depend on those; among them
 * folders come after materials (a purged material releases its folder link first).
 */
const PURGE_PREFIX = ["assessments", "templates", "questions"] as const;
const PURGE_ROTATIONS = [
  ["materials", "folders", "solverSessions"],
  ["solverSessions", "materials", "folders"],
  ["materials", "solverSessions", "folders"],
] as const;
export type PurgeKind =
  (typeof PURGE_PREFIX)[number] | (typeof PURGE_ROTATIONS)[number][number];

/**
 * One kind's purge of a run: it stops when `outOfTime` says so and records in `skip` the rows
 * that failed (and does not try those again in the same run).
 */
type KindPurge = (
  outOfTime: () => boolean,
  skip: Set<string>,
) => Promise<{ purged: number; failed: number }>;

/**
 * The order of one day's purge: the dependency-ordered prefix, then the independent kinds in an
 * order that changes with the day (final review M7). purgeTrashOncePerDay gives each kind a share
 * of the time left when it starts, at least one row each, and a second pass for what is left, so
 * a heavy backlog in one kind never starves another; its own rows wait for the next day.
 */
export function purgeOrder(day: string): PurgeKind[] {
  const days = Math.floor(Date.parse(`${day}T00:00:00.000Z`) / 86_400_000);
  const index =
    ((days % PURGE_ROTATIONS.length) + PURGE_ROTATIONS.length) % PURGE_ROTATIONS.length;
  return [...PURGE_PREFIX, ...PURGE_ROTATIONS[index]];
}

/** The Asia/Jakarta calendar day of `at` (UTC+7, no daylight saving) as yyyy-mm-dd. */
export function jakartaDayKey(at: Date): string {
  return new Date(at.getTime() + JAKARTA_OFFSET_MS).toISOString().slice(0, 10);
}

// Regeneration jobs (generation/service/regenerate.ts): only jobs that have not started are
// cancelled: a running one re-checks the trash under its row lock and writes nothing.
const NOT_STARTED = ["queued", "deferred"];

/**
 * Cancels the regeneration jobs of this question that have not started, so a deferred job can
 * neither bring the question back to life nor spend AI quota on it. A cancelled job may already have
 * saved its new version: unless a running job will settle it itself, the approval is settled now as
 * an ended job (R19), so a restore from the trash finds a consistent question. Returns how many jobs
 * were cancelled.
 */
export async function cancelPendingRegeneration(
  db: AnyDb,
  input: { ownerId: string; questionId: string; now: Date },
): Promise<number> {
  const cancelled = await db
    .update(jobs)
    .set({ status: "cancelled", updatedAt: input.now })
    .where(
      and(
        eq(jobs.ownerId, input.ownerId),
        eq(jobs.type, REGENERATE_JOB_TYPE),
        inArray(jobs.status, NOT_STARTED),
        sql`${jobs.payload}->>'questionId' = ${input.questionId}`,
      ),
    )
    .returning({ id: jobs.id });
  if (
    cancelled.length > 0 &&
    (await findPendingRegeneration(db, {
      ownerId: input.ownerId,
      questionId: input.questionId,
    })) === null
  ) {
    await settleRegenerationApproval(db, { ...input, jobEnded: true });
  }
  return cancelled.length;
}

/** The titles of the owner's assessments (trashed ones too) with an item pinning the question. */
async function assessmentsPinning(
  db: AnyDb,
  ownerId: string,
  questionId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: assessments.id, title: assessments.title })
    .from(assessmentItems)
    .innerJoin(
      assessments,
      and(
        eq(assessments.id, assessmentItems.assessmentId),
        eq(assessments.ownerId, assessmentItems.ownerId),
      ),
    )
    .where(
      and(
        eq(assessmentItems.ownerId, ownerId),
        eq(assessmentItems.questionId, questionId),
      ),
    )
    .orderBy(asc(assessments.title), asc(assessments.id));
  return rows.map((row) => row.title);
}

export const isInUse = (value: PurgeCounts | InUse): value is InUse => "code" in value;

/**
 * Deletes one trashed question in one transaction. The row is locked first and the guard
 * (in the trash; past purge_after when `expiredBy` is given; this owner when `ownerId` is given)
 * is checked under that lock, so a restore that committed first wins and a restore that comes
 * second finds no row. Returns the counts, `inUse` when an assessment pins it (nothing written,
 * R2), or null when the guard did not hold (nothing written).
 */
export async function purgeQuestion(
  db: AnyDb,
  input: { questionId: string; ownerId?: string; expiredBy?: Date; now: Date },
): Promise<PurgeCounts | InUse | null> {
  const { questionId, now } = input;
  return db.transaction(async (tx) => {
    const guard = and(
      eq(questions.id, questionId),
      isNotNull(questions.deletedAt),
      input.ownerId === undefined ? undefined : eq(questions.ownerId, input.ownerId),
      input.expiredBy === undefined
        ? undefined
        : lte(questions.purgeAfter, input.expiredBy),
    );
    const locked = (
      await tx
        .select({ ownerId: questions.ownerId })
        .from(questions)
        .where(guard)
        .for("update")
    ).at(0);
    if (!locked) return null;
    const { ownerId } = locked;

    const pinnedBy = await assessmentsPinning(tx, ownerId, questionId);
    if (pinnedBy.length > 0) return { code: "inUse", assessments: pinnedBy } as const;

    const versionIds = (
      await tx
        .select({ id: questionVersions.id })
        .from(questionVersions)
        .where(
          and(
            eq(questionVersions.questionId, questionId),
            eq(questionVersions.ownerId, ownerId),
          ),
        )
    ).map((row) => row.id);
    const countOf = async (
      table: typeof verificationRuns | typeof questionSources,
    ): Promise<number> => {
      if (versionIds.length === 0) return 0;
      const row = (
        await tx
          .select({ n: count() })
          .from(table)
          .where(
            and(eq(table.ownerId, ownerId), inArray(table.questionVersionId, versionIds)),
          )
      ).at(0);
      return row?.n ?? 0;
    };
    const counts: PurgeCounts = {
      versions: versionIds.length,
      verificationRuns: await countOf(verificationRuns),
      sources: await countOf(questionSources),
    };

    // A regeneration that had not started yet can never run for a question that is gone.
    await cancelPendingRegeneration(tx, { ownerId, questionId, now });
    // The cascade takes the versions, their runs and sources.
    await tx
      .delete(questions)
      .where(and(eq(questions.id, questionId), eq(questions.ownerId, ownerId)));
    await tx.insert(deletionLog).values({
      ownerId,
      entity: DELETION_ENTITY_QUESTION,
      entityId: questionId,
      counts: { questions: 1, ...counts },
      deletedAt: now,
    });
    return counts;
  });
}

/**
 * Deletes every trashed question of every owner whose purge_after is at or before `now`
 * (service connection). Idempotent: a second run finds nothing left. Each question is its own
 * guarded transaction (a savepoint inside the daily run): a question that fails is rolled back
 * whole, logged by id with the error name and code only, counted in `failed` and retried on the
 * next run; it never stops the others. A question pinned by an assessment is not a candidate
 * (R2): it is counted in one log line per run (a count only) and waits until the assessment is
 * gone. Candidates go oldest purge_after first, ties by id.
 */
export async function purgeExpired(
  db: AnyDb,
  now: Date,
  options: { batch?: number; outOfTime?: () => boolean; skip?: Set<string> } = {},
): Promise<{ purged: number; failed: number }> {
  const expired = and(isNotNull(questions.deletedAt), lte(questions.purgeAfter, now));
  // A pinned question can wait in the trash for as long as its assessment exists: it is left out
  // of the candidates, or a batch full of them would starve every expired question behind them.
  // purgeQuestion re-checks the pin under the row lock (an item added meanwhile).
  const pinned = exists(
    db
      .select({ one: sql`1` })
      .from(assessmentItems)
      .where(
        and(
          eq(assessmentItems.questionId, questions.id),
          eq(assessmentItems.ownerId, questions.ownerId),
        ),
      ),
  );
  const candidates = await db
    .select({ id: questions.id })
    .from(questions)
    .where(and(expired, not(pinned)))
    .orderBy(asc(questions.purgeAfter), asc(questions.id))
    .limit(options.batch ?? PURGE_BATCH);
  const blocked = (
    await db.select({ n: count() }).from(questions).where(and(expired, pinned))
  ).at(0)?.n;
  if (blocked) {
    logger.info(
      { module: "trash", blockedQuestions: blocked },
      "trash: expired questions pinned by an assessment are kept",
    );
  }
  let purged = 0;
  let failed = 0;
  for (const { id } of candidates) {
    // A row that already failed in this run is not tried again before the others (R31).
    if (options.skip?.has(id)) continue;
    // The run's time budget is spent: the rest waits for the next run (nothing failed).
    if (options.outOfTime?.()) break;
    try {
      const outcome = await purgeQuestion(db, { questionId: id, expiredBy: now, now });
      if (outcome === null) continue;
      if (isInUse(outcome)) {
        logger.info(
          { module: "trash", questionId: id, assessments: outcome.assessments.length },
          "trash: question pinned by an assessment; not purged",
        );
        continue;
      }
      purged += 1;
    } catch (error) {
      failed += 1;
      options.skip?.add(id);
      logger.error(
        { module: "trash", questionId: id, err: safeErrorSummary(error) },
        "trash: could not purge a question",
      );
    }
  }
  return { purged, failed };
}

// One store call of the purge may take at most this long; past it the row fails and is retried.
export const STORE_CALL_TIMEOUT_MS = 45_000;
// The whole daily run takes no new row after this long (one store call may still be in flight, so
// the run ends within about TRASH_PURGE_BUDGET_MS + STORE_CALL_TIMEOUT_MS); the rest waits for the
// next day. Part of the daily run's budget (src/lib/jobs/tick.ts, runbook).
export const TRASH_PURGE_BUDGET_MS = 60_000;
// A claimed day always gets at least this long, so it attempts at least one row.
const MIN_PURGE_BUDGET_MS = 5_000;

/**
 * The daily purge of the daily jobs run: at most once per Asia/Jakarta day, the expired assessments
 * first (they free the templates and questions they use), then the templates, the questions, the
 * learning materials (with their files) and last the folders.
 *
 * The day is CLAIMED first, in a short transaction under an advisory lock: today's marker (an
 * audit_log row with no owner, the day and later the counts only) is checked and written, then
 * committed. Every row is then purged in its own top-level transaction (rows, deletion_log, then
 * its files), so a failure, a killed function or a lost connection later in the run never brings
 * back a row that was already purged, and a row that fails keeps all of its files. Rows that fail
 * are logged and retried the next day (R17); so are the rows a run that died never reached, and
 * the rows left when the run's time budget (`budgetMs`, TRASH_PURGE_BUDGET_MS) was spent. The
 * marker's counts (`purged` and `failed` add up every entity) are written at the end; a failure
 * there is logged and loses only the counts. Every store call is bounded by `storeTimeoutMs`. The
 * object store is asked for only by a row with files to delete, so a deploy without one still
 * purges everything else. Returns null when today's purge already ran (or is running).
 */
export async function purgeTrashOncePerDay(
  db: AnyDb,
  now: Date,
  store: StoreSource = () => {
    throw new Error("trash: no object store given");
  },
  options: {
    storeTimeoutMs?: number;
    budgetMs?: number;
    clock?: () => number;
    /** Test seam: a kind's purge, given its own out-of-time check. */
    purgers?: Partial<Record<PurgeKind, KindPurge>>;
    /** Called once when the run's budget ended with a kind cut short (work left for tomorrow). */
    onBacklog?: () => void;
  } = {},
): Promise<{ purged: number; failed: number } | null> {
  const clock = options.clock ?? Date.now;
  const started = clock();
  const budgetMs = Math.max(
    options.budgetMs ?? TRASH_PURGE_BUDGET_MS,
    MIN_PURGE_BUDGET_MS,
  );
  const outOfTime = () => clock() - started >= budgetMs;
  const day = jakartaDayKey(now);
  const markerId = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('purge_trash', 0))`,
    );
    const done = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          isNull(auditLog.ownerId),
          eq(auditLog.action, AUDIT_TRASH_PURGED),
          sql`${auditLog.metadata}->>'day' = ${day}`,
        ),
      )
      .limit(1);
    if (done.length > 0) return null;
    const [marker] = await tx
      .insert(auditLog)
      .values({
        ownerId: null,
        action: AUDIT_TRASH_PURGED,
        metadata: { day },
        createdAt: now,
      })
      .returning({ id: auditLog.id });
    return marker.id;
  });
  if (markerId === null) return null;
  // The claim itself used the budget (a slow database): give the day back instead of keeping a
  // claim that purged nothing, so the next run of the day can still purge.
  if (outOfTime()) {
    try {
      await db.delete(auditLog).where(eq(auditLog.id, markerId));
    } catch (error) {
      logger.error(
        { module: "trash", err: safeErrorSummary(error) },
        "trash: could not release the day's purge claim; the purge waits for tomorrow",
      );
    }
    options.onBacklog?.();
    return { purged: 0, failed: 0 };
  }

  const bounded = boundedStore(store, options.storeTimeoutMs ?? STORE_CALL_TIMEOUT_MS);
  const purgeOf: Record<PurgeKind, KindPurge> = {
    assessments: (late, skip) =>
      purgeExpiredAssessments(db, bounded, now, { outOfTime: late, skip }),
    templates: (late, skip) =>
      purgeExpiredTemplates(db, bounded, now, { outOfTime: late, skip }),
    questions: (late, skip) => purgeExpired(db, now, { outOfTime: late, skip }),
    materials: (late, skip) =>
      purgeExpiredMaterials(db, bounded, now, { outOfTime: late, skip }),
    folders: (late, skip) => purgeExpiredFolders(db, now, { outOfTime: late, skip }),
    solverSessions: (late, skip) =>
      purgeExpiredSolverSessions(db, bounded, now, { outOfTime: late, skip }),
    ...options.purgers,
  };
  // Each kind gets a share of the time left when it STARTS (what remains, divided by the kinds
  // still to go), so an overrun costs the remaining kinds proportionally and unused time rolls
  // forward on its own. Every kind may always attempt one row while the run's budget lasts, so a
  // share smaller than one row cannot starve it. A second pass in the same order then lets the
  // earlier (dependency-first) kinds reclaim whatever the others left.
  const results: { purged: number; failed: number }[] = [];
  // Rows that failed in this run (ids are uuids, unique across kinds): the second pass does not
  // try them again before the others; they wait for the next day (R31).
  const failedThisRun = new Set<string>();
  let pending: PurgeKind[] = purgeOrder(day);
  for (let pass = 0; pass < 2 && pending.length > 0 && !outOfTime(); pass += 1) {
    // Only a kind its share cut short comes back in the second pass (one that finished, or whose
    // rows failed, would only repeat itself).
    const cut: PurgeKind[] = [];
    for (const [index, kind] of pending.entries()) {
      if (outOfTime()) {
        // Not reached this pass: still owed.
        cut.push(...pending.slice(index));
        break;
      }
      const startedKind = clock();
      const until =
        startedKind + (started + budgetMs - startedKind) / (pending.length - index);
      let first = true;
      const state = { stopped: false };
      const late = () => {
        if (first) {
          first = false;
          return outOfTime();
        }
        state.stopped = outOfTime() || clock() >= until;
        return state.stopped;
      };
      results.push(await purgeOf[kind](late, failedThisRun));
      if (state.stopped) cut.push(kind);
    }
    pending = cut;
  }
  // A kind still cut short after the last pass (or never reached) has rows left for tomorrow.
  if (pending.length > 0) options.onBacklog?.();
  const result = {
    purged: results.reduce((sum, r) => sum + r.purged, 0),
    failed: results.reduce((sum, r) => sum + r.failed, 0),
  };
  try {
    await db
      .update(auditLog)
      .set({ metadata: { day, purged: result.purged, failed: result.failed } })
      .where(eq(auditLog.id, markerId));
  } catch (error) {
    logger.error(
      { module: "trash", err: safeErrorSummary(error) },
      "trash: could not record the counts of the daily purge",
    );
  }
  return result;
}
