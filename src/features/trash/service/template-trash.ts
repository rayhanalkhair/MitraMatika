// The trash for school templates (decision 10). Same shape as the assessment trash: writes on the
// service connection naming owner_id in every statement, the list under runAsUser (the page).
//
// A trashed template is invisible to the templates feature (not listed, not choosable, not the
// default) and an assessment that still uses it cannot be approved until another template is
// chosen (approval reports `trashed` for the template). Restoring brings it back as it was, except
// that a template that was the default comes back as a plain one when another template became the
// default meanwhile (at most one default per teacher).
//
// Deleting for good is refused while any assessment, trashed or not, uses the template (the
// foreign key is NO ACTION): the teacher is told which ones, and the purge skips it until they are
// gone. The logo goes LAST, under the row lock and inside the same transaction, after the row delete
// and the deletion_log entry, by deletePrefix on the template's own prefix
// `templates/<ownerId>/<templateId>/` (R13: never the raw logo_key column). Logos have no
// lifecycle rule, so this order matters: a database failure happens before the logo is touched,
// and a storage failure (or a call past its bound) rolls the rows back and the delete is retried.
// A logo is never left behind without its row.
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  not,
  sql,
} from "drizzle-orm";
import { assessments, deletionLog, schoolTemplates } from "@/lib/db/schema";
import type { AnyDb } from "@/features/generation";
import { logger } from "@/lib/logger";
import { err, ok, type Result } from "@/lib/result";
import type { StoreSource } from "./assessment-trash";
import { safeErrorSummary } from "./error-summary";
import { daysLeft, purgeAfterFrom, type InUse, type TrashFailure } from "./retention";
import { templatePrefix } from "./storage-keys";

export const DELETION_ENTITY_TEMPLATE = "template";
// One purge run deletes at most this many templates; the rest go the next day.
const PURGE_BATCH = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TemplatePurgeCounts {
  /** Objects removed under the template's own prefix (its logo). */
  logoFiles: number;
}

const ofTemplate = (ownerId: string, templateId: string) =>
  and(eq(schoolTemplates.id, templateId), eq(schoolTemplates.ownerId, ownerId));

async function ownsTemplate(db: AnyDb, ownerId: string, templateId: string) {
  const rows = await db
    .select({ id: schoolTemplates.id })
    .from(schoolTemplates)
    .where(ofTemplate(ownerId, templateId))
    .limit(1);
  return rows.length > 0;
}

/** The titles of the owner's assessments (trashed ones too) that use the template. */
async function assessmentsUsing(
  db: AnyDb,
  ownerId: string,
  templateIds: string[],
): Promise<{ templateId: string; title: string }[]> {
  if (templateIds.length === 0) return [];
  const rows = await db
    .select({ templateId: assessments.templateId, title: assessments.title })
    .from(assessments)
    .where(
      and(eq(assessments.ownerId, ownerId), inArray(assessments.templateId, templateIds)),
    )
    .orderBy(asc(assessments.title), asc(assessments.id));
  return rows.flatMap((row) =>
    row.templateId === null ? [] : [{ templateId: row.templateId, title: row.title }],
  );
}

/**
 * Moves one of the owner's templates to the trash: deleted_at now, purge_after now + 30 days.
 * Nothing else changes (a default keeps its flag for a restore; the one-default index ignores
 * trashed rows). Unknown, foreign or already trashed ids are notFound.
 */
export async function trashTemplate(
  db: AnyDb,
  input: { ownerId: string; templateId: string; now: Date },
): Promise<Result<void, TrashFailure>> {
  const { ownerId, templateId, now } = input;
  if (!UUID.test(templateId)) return err("notFound");
  const updated = await db
    .update(schoolTemplates)
    .set({ deletedAt: now, purgeAfter: purgeAfterFrom(now) })
    .where(and(ofTemplate(ownerId, templateId), isNull(schoolTemplates.deletedAt)))
    .returning({ id: schoolTemplates.id });
  return updated.length > 0 ? ok() : err("notFound");
}

const ONE_DEFAULT_INDEX = "school_templates_one_default_per_owner";
interface PgErrorFields {
  code?: unknown;
  constraint?: unknown;
  constraint_name?: unknown;
}
// Another template became the default between our check and our write.
function isDefaultRace(error: unknown): boolean {
  const outer = error as (PgErrorFields & { cause?: PgErrorFields }) | null | undefined;
  const source = outer?.code === undefined ? outer?.cause : outer;
  const constraint = source?.constraint ?? source?.constraint_name;
  return source?.code === "23505" && constraint === ONE_DEFAULT_INDEX;
}

async function restoreOnce(
  db: AnyDb,
  input: { ownerId: string; templateId: string },
): Promise<{ defaultDropped: boolean } | null> {
  const { ownerId, templateId } = input;
  return db.transaction(async (tx) => {
    const row = (
      await tx
        .select({ isDefault: schoolTemplates.isDefault })
        .from(schoolTemplates)
        .where(and(ofTemplate(ownerId, templateId), isNotNull(schoolTemplates.deletedAt)))
        .for("update")
    ).at(0);
    if (!row) return null;
    const slotTaken =
      row.isDefault &&
      (
        await tx
          .select({ id: schoolTemplates.id })
          .from(schoolTemplates)
          .where(
            and(
              eq(schoolTemplates.ownerId, ownerId),
              ne(schoolTemplates.id, templateId),
              eq(schoolTemplates.isDefault, true),
              isNull(schoolTemplates.deletedAt),
            ),
          )
          .limit(1)
      ).length > 0;
    await tx
      .update(schoolTemplates)
      .set(
        slotTaken
          ? {
              deletedAt: null,
              purgeAfter: null,
              isDefault: false,
              // The default flag changed: an open form of it gets a conflict, like a default switch.
              // Nothing printed changed, so an approved assessment printing with it stays valid
              // (R26); the caller tells the teacher it is no longer the default (`defaultDropped`).
              rowVersion: sql`${schoolTemplates.rowVersion} + 1`,
              updatedAt: new Date(),
            }
          : { deletedAt: null, purgeAfter: null },
      )
      .where(ofTemplate(ownerId, templateId));
    return { defaultDropped: slotTaken };
  });
}

/**
 * Takes a template out of the trash as it was; a default whose slot was taken meanwhile comes back
 * as a plain template with a new row version (`defaultDropped`). The row is locked, so a purge waiting on it re-checks deleted_at and skips
 * it. A default made elsewhere at the same moment is retried once (it then sees the slot taken).
 */
export async function restoreTemplate(
  db: AnyDb,
  input: { ownerId: string; templateId: string },
): Promise<Result<{ defaultDropped: boolean }, TrashFailure>> {
  const { ownerId, templateId } = input;
  if (!UUID.test(templateId)) return err("notFound");
  let restored: { defaultDropped: boolean } | null;
  try {
    restored = await restoreOnce(db, input);
  } catch (error) {
    if (!isDefaultRace(error)) throw error;
    restored = await restoreOnce(db, input);
  }
  if (restored) return ok(restored);
  return err((await ownsTemplate(db, ownerId, templateId)) ? "notInTrash" : "notFound");
}

/**
 * Deletes one trashed template in one transaction, guarded under the row lock like
 * purgeAssessment. Returns the counts, `inUse` (nothing written, the store not even asked) while
 * an assessment uses it, or null when the guard did not hold.
 */
export async function purgeTemplate(
  db: AnyDb,
  store: StoreSource,
  input: { templateId: string; ownerId?: string; expiredBy?: Date; now: Date },
): Promise<TemplatePurgeCounts | InUse | null> {
  const { templateId, now } = input;
  if (!UUID.test(templateId)) return null;
  return db.transaction(async (tx) => {
    const locked = (
      await tx
        .select({ ownerId: schoolTemplates.ownerId, logoKey: schoolTemplates.logoKey })
        .from(schoolTemplates)
        .where(
          and(
            eq(schoolTemplates.id, templateId),
            isNotNull(schoolTemplates.deletedAt),
            input.ownerId === undefined
              ? undefined
              : eq(schoolTemplates.ownerId, input.ownerId),
            input.expiredBy === undefined
              ? undefined
              : lte(schoolTemplates.purgeAfter, input.expiredBy),
          ),
        )
        .for("update")
    ).at(0);
    if (!locked) return null;
    const { ownerId } = locked;

    const users = await assessmentsUsing(tx, ownerId, [templateId]);
    if (users.length > 0) {
      return { code: "inUse", assessments: users.map((user) => user.title) } as const;
    }

    // Database first.
    await tx.delete(schoolTemplates).where(ofTemplate(ownerId, templateId));
    await tx.insert(deletionLog).values({
      ownerId,
      entity: DELETION_ENTITY_TEMPLATE,
      entityId: templateId,
      counts: { templates: 1, logos: locked.logoKey === null ? 0 : 1 },
      deletedAt: now,
    });
    // Storage last, the template's whole own prefix whatever the column says: a rewritten logo_key
    // cannot reach another object, and a logo whose row write failed (logo_key still null) goes
    // too, since logos have no lifecycle rule. Every template purge therefore needs the store.
    const logoFiles = await store().deletePrefix(templatePrefix(ownerId, templateId));
    return { logoFiles };
  });
}

const isInUse = (value: TemplatePurgeCounts | InUse): value is InUse => "code" in value;

/** The teacher's "delete for good": refused when not in the trash or still used. */
export async function deleteTemplatePermanently(
  db: AnyDb,
  store: StoreSource,
  input: { ownerId: string; templateId: string; now: Date },
): Promise<Result<TemplatePurgeCounts, TrashFailure | InUse>> {
  const { ownerId, templateId, now } = input;
  const outcome = await purgeTemplate(db, store, { templateId, ownerId, now });
  if (outcome) return isInUse(outcome) ? err(outcome) : ok(outcome);
  return err((await ownsTemplate(db, ownerId, templateId)) ? "notInTrash" : "notFound");
}

/**
 * Deletes every expired trashed template of every owner, each in its own guarded transaction.
 * One still used by an assessment is not a candidate (counted in one log line per run) until the
 * assessment is gone; one that fails is rolled back, logged and retried the next day. Idempotent.
 */
export async function purgeExpiredTemplates(
  db: AnyDb,
  store: StoreSource,
  now: Date,
  options: { batch?: number; outOfTime?: () => boolean; skip?: Set<string> } = {},
): Promise<{ purged: number; failed: number }> {
  const expired = and(
    isNotNull(schoolTemplates.deletedAt),
    lte(schoolTemplates.purgeAfter, now),
  );
  // A template in use waits for its assessments: it is left out of the candidates, or a batch full
  // of them would starve every expired template behind them. purgeTemplate re-checks the use
  // under the row lock (an assessment pointed at it meanwhile).
  const inUse = exists(
    db
      .select({ one: sql`1` })
      .from(assessments)
      .where(
        and(
          eq(assessments.templateId, schoolTemplates.id),
          eq(assessments.ownerId, schoolTemplates.ownerId),
        ),
      ),
  );
  const blocked = (
    await db.select({ n: count() }).from(schoolTemplates).where(and(expired, inUse))
  ).at(0)?.n;
  if (blocked) {
    logger.info(
      { module: "trash", blockedTemplates: blocked },
      "trash: expired templates still used by an assessment are kept",
    );
  }
  const candidates = await db
    .select({ id: schoolTemplates.id })
    .from(schoolTemplates)
    .where(and(expired, not(inUse)))
    .orderBy(asc(schoolTemplates.purgeAfter), asc(schoolTemplates.id))
    .limit(options.batch ?? PURGE_BATCH);
  let purged = 0;
  let failed = 0;
  for (const { id } of candidates) {
    // A row that already failed in this run is not tried again before the others (R31).
    if (options.skip?.has(id)) continue;
    // The run's time budget is spent: the rest waits for the next run (nothing failed).
    if (options.outOfTime?.()) break;
    try {
      const outcome = await purgeTemplate(db, store, {
        templateId: id,
        expiredBy: now,
        now,
      });
      if (outcome === null) continue;
      if (isInUse(outcome)) {
        logger.info(
          { module: "trash", templateId: id, assessments: outcome.assessments.length },
          "trash: template still used by an assessment; not purged",
        );
        continue;
      }
      purged += 1;
    } catch (error) {
      failed += 1;
      options.skip?.add(id);
      logger.error(
        { module: "trash", templateId: id, err: safeErrorSummary(error) },
        "trash: could not purge a template",
      );
    }
  }
  return { purged, failed };
}

export interface TrashedTemplate {
  templateId: string;
  name: string;
  schoolName: string;
  hasLogo: boolean;
  /** Titles of the assessments that still use it (a permanent delete is refused while any do). */
  usedBy: string[];
  deletedAt: string;
  purgeAfter: string;
  daysLeft: number;
}

/** The owner's trashed templates, most recently deleted first. */
export async function listTrashedTemplates(
  db: AnyDb,
  input: { ownerId: string; now: Date },
): Promise<TrashedTemplate[]> {
  const { ownerId, now } = input;
  const rows = await db
    .select({
      id: schoolTemplates.id,
      name: schoolTemplates.name,
      schoolName: schoolTemplates.schoolName,
      logoKey: schoolTemplates.logoKey,
      deletedAt: schoolTemplates.deletedAt,
      purgeAfter: schoolTemplates.purgeAfter,
    })
    .from(schoolTemplates)
    .where(
      and(eq(schoolTemplates.ownerId, ownerId), isNotNull(schoolTemplates.deletedAt)),
    )
    .orderBy(desc(schoolTemplates.deletedAt), asc(schoolTemplates.id));
  if (rows.length === 0) return [];
  const users = await assessmentsUsing(
    db,
    ownerId,
    rows.map((row) => row.id),
  );
  return rows.flatMap((row) => {
    if (!row.deletedAt || !row.purgeAfter) return [];
    return [
      {
        templateId: row.id,
        name: row.name,
        schoolName: row.schoolName,
        hasLogo: row.logoKey !== null,
        usedBy: users
          .filter((user) => user.templateId === row.id)
          .map((user) => user.title),
        deletedAt: row.deletedAt.toISOString(),
        purgeAfter: row.purgeAfter.toISOString(),
        daysLeft: daysLeft(row.purgeAfter, now),
      },
    ];
  });
}
