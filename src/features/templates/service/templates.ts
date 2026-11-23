// School document templates (decision 7). The caller applies `runAsUser`, so every statement also
// runs under RLS (Ruling R1); each one names owner_id as well. A trashed template (deleted_at set)
// is invisible here: not listed, not found, not editable.
import "server-only";
import { and, asc, count, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import { MAX_TEMPLATES_PER_TEACHER } from "@/lib/storage/limits";
import { schoolTemplates } from "@/lib/db/schema";
import { err, ok, type Result } from "@/lib/result";
import {
  FONTS,
  PAPER_SIZES,
  STUDENT_FIELDS,
  type TemplateInput,
  type TemplateView,
} from "../schema/template";

export type TemplateDb = PgAsyncDatabase<PgQueryResultHKT, AnyRelations>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A malformed id can name no template; checked before it reaches a uuid column. */
export const isUuid = (value: string) => UUID.test(value);

type Row = typeof schoolTemplates.$inferSelect;

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

function toView(row: Row): TemplateView {
  const fields = strings(row.studentFields);
  return {
    id: row.id,
    name: row.name,
    schoolName: row.schoolName,
    headerLines: strings(row.headerLines),
    subject: row.subject,
    studentFields: STUDENT_FIELDS.filter((field) => fields.includes(field)),
    defaultInstructions: row.defaultInstructionsMd,
    paperSize: PAPER_SIZES.find((size) => size === row.paperSize) ?? "A4",
    font: FONTS.find((font) => font === row.font) ?? "times",
    isDefault: row.isDefault,
    rowVersion: row.rowVersion,
    hasLogo: row.logoKey !== null,
    logoIsSvg: row.logoKey?.endsWith(".svg") ?? false,
  };
}

const visible = (ownerId: string) =>
  and(eq(schoolTemplates.ownerId, ownerId), isNull(schoolTemplates.deletedAt));

/** The owner's templates, the default first, then by name. */
export async function listTemplates(
  tx: TemplateDb,
  ownerId: string,
): Promise<TemplateView[]> {
  const rows = await tx
    .select()
    .from(schoolTemplates)
    .where(visible(ownerId))
    .orderBy(
      desc(schoolTemplates.isDefault),
      asc(schoolTemplates.name),
      asc(schoolTemplates.id),
    );
  return rows.map(toView);
}

export async function getTemplate(
  tx: TemplateDb,
  input: { ownerId: string; templateId: string },
): Promise<Result<TemplateView, "notFound">> {
  if (!isUuid(input.templateId)) return err("notFound");
  const row = (
    await tx
      .select()
      .from(schoolTemplates)
      .where(and(eq(schoolTemplates.id, input.templateId), visible(input.ownerId)))
      .limit(1)
  ).at(0);
  return row ? ok(toView(row)) : err("notFound");
}

/** Clears the owner's current default (other than `keepId`), before another one is set. */
async function clearDefault(
  tx: TemplateDb,
  ownerId: string,
  keepId?: string,
): Promise<void> {
  await tx
    .update(schoolTemplates)
    .set({
      isDefault: false,
      rowVersion: sql`${schoolTemplates.rowVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        visible(ownerId),
        eq(schoolTemplates.isDefault, true),
        keepId ? ne(schoolTemplates.id, keepId) : undefined,
      ),
    );
}

async function hasDefault(tx: TemplateDb, ownerId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: schoolTemplates.id })
    .from(schoolTemplates)
    .where(and(visible(ownerId), eq(schoolTemplates.isDefault, true)))
    .limit(1);
  return rows.length > 0;
}

const columns = (input: TemplateInput) => ({
  name: input.name,
  schoolName: input.schoolName,
  headerLines: input.headerLines,
  subject: input.subject,
  studentFields: input.studentFields,
  defaultInstructionsMd: input.defaultInstructions,
  paperSize: input.paperSize,
  font: input.font,
});

type WriteFailure = "notFound" | "conflict" | "tooMany";

/** Thrown inside a write to roll it back as a whole; mapped to a Result by `atomically`. */
class TemplateWriteAborted extends Error {
  constructor(readonly reason: WriteFailure) {
    super(`template write aborted: ${reason}`);
  }
}

const ONE_DEFAULT_INDEX = "school_templates_one_default_per_owner";

interface PgErrorFields {
  code?: unknown;
  constraint?: unknown;
  constraint_name?: unknown;
}

// Another tab made a default between our check and our write. The Postgres fields are on the
// error itself or on the driver error Drizzle wraps (PGlite: constraint, postgres.js: constraint_name).
function isDefaultRace(error: unknown): boolean {
  const outer = error as (PgErrorFields & { cause?: PgErrorFields }) | null | undefined;
  const source = outer?.code === undefined ? outer?.cause : outer;
  const constraint = source?.constraint ?? source?.constraint_name;
  return source?.code === "23505" && constraint === ONE_DEFAULT_INDEX;
}

/**
 * Runs a multi-statement write in a savepoint: a TemplateWriteAborted, or the one-default index
 * refusing a concurrent default, rolls every statement of it back (the default is never left
 * cleared) and comes back as `conflict` or `notFound`. The outer transaction stays usable.
 */
async function atomically<T>(
  tx: TemplateDb,
  write: (sp: TemplateDb) => Promise<T>,
): Promise<Result<T, WriteFailure>> {
  try {
    return ok(await tx.transaction((sp) => write(sp as unknown as TemplateDb)));
  } catch (error) {
    if (error instanceof TemplateWriteAborted) return err(error.reason);
    if (isDefaultRace(error)) return err("conflict");
    throw error;
  }
}

/** Locks the visible template row for the rest of the transaction, or aborts with notFound. */
async function lockTemplate(
  tx: TemplateDb,
  ownerId: string,
  templateId: string,
): Promise<{ rowVersion: number; isDefault: boolean }> {
  const row = (
    await tx
      .select({
        rowVersion: schoolTemplates.rowVersion,
        isDefault: schoolTemplates.isDefault,
      })
      .from(schoolTemplates)
      .where(and(eq(schoolTemplates.id, templateId), visible(ownerId)))
      .for("update")
  ).at(0);
  if (!row) throw new TemplateWriteAborted("notFound");
  return row;
}

/**
 * Creates (no templateId) or updates a template. An update must name the row version the teacher
 * saw (optimistic lock): a stale one is `conflict`, another teacher's or a trashed template is
 * `notFound`. Exactly one default per owner: the first template becomes the default, saving one
 * with isDefault moves the default to it, and unticking the current default keeps it. The row is
 * locked before the version check, and any refusal rolls the whole write back (a savepoint), so
 * the old default is never left cleared. A concurrent first default is a retryable `conflict`.
 */
export async function saveTemplate(
  tx: TemplateDb,
  input: {
    ownerId: string;
    templateId?: string;
    input: TemplateInput;
    expectedRowVersion?: number;
  },
): Promise<Result<{ id: string; rowVersion: number }, WriteFailure>> {
  const { ownerId, templateId, expectedRowVersion } = input;
  const values = columns(input.input);

  if (templateId === undefined) {
    return atomically(tx, async (sp) => {
      // A bounded number of rows per teacher (trashed ones count until purged): each may hold a
      // logo, and the rows themselves must not pile up (security review F1).
      const [owned] = await sp
        .select({ n: count() })
        .from(schoolTemplates)
        .where(eq(schoolTemplates.ownerId, ownerId));
      if (owned.n >= MAX_TEMPLATES_PER_TEACHER) throw new TemplateWriteAborted("tooMany");
      const makeDefault = input.input.isDefault || !(await hasDefault(sp, ownerId));
      if (makeDefault) await clearDefault(sp, ownerId);
      const created = (
        await sp
          .insert(schoolTemplates)
          .values({ ...values, ownerId, isDefault: makeDefault })
          .returning({ id: schoolTemplates.id, rowVersion: schoolTemplates.rowVersion })
      ).at(0);
      if (!created) throw new TemplateWriteAborted("conflict");
      return created;
    });
  }

  if (!isUuid(templateId)) return err("notFound");
  return atomically(tx, async (sp) => {
    const current = await lockTemplate(sp, ownerId, templateId);
    if (expectedRowVersion === undefined || current.rowVersion !== expectedRowVersion) {
      throw new TemplateWriteAborted("conflict");
    }
    if (input.input.isDefault) await clearDefault(sp, ownerId, templateId);
    const updated = (
      await sp
        .update(schoolTemplates)
        .set({
          ...values,
          // Never unset here: the default only moves when another template becomes the default.
          ...(input.input.isDefault ? { isDefault: true } : {}),
          rowVersion: sql`${schoolTemplates.rowVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schoolTemplates.id, templateId),
            visible(ownerId),
            eq(schoolTemplates.rowVersion, expectedRowVersion),
          ),
        )
        .returning({ id: schoolTemplates.id, rowVersion: schoolTemplates.rowVersion })
    ).at(0);
    if (!updated) throw new TemplateWriteAborted("conflict");
    return updated;
  });
}

/** Makes the template the owner's only default; all or nothing (see saveTemplate). */
export async function setDefaultTemplate(
  tx: TemplateDb,
  input: { ownerId: string; templateId: string },
): Promise<Result<void, WriteFailure>> {
  const { ownerId, templateId } = input;
  if (!isUuid(templateId)) return err("notFound");
  const result = await atomically(tx, async (sp) => {
    const current = await lockTemplate(sp, ownerId, templateId);
    if (current.isDefault) return;
    // The partial unique index allows one default at a time: clear first, then set.
    await clearDefault(sp, ownerId, templateId);
    const set = await sp
      .update(schoolTemplates)
      .set({
        isDefault: true,
        rowVersion: sql`${schoolTemplates.rowVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(schoolTemplates.id, templateId), visible(ownerId)))
      .returning({ id: schoolTemplates.id });
    if (set.length === 0) throw new TemplateWriteAborted("notFound");
  });
  // A default made elsewhere meanwhile is a retryable conflict.
  return result.ok ? ok() : result;
}
