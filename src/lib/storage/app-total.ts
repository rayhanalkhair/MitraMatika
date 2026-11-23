import "server-only";
import { and, eq, gt, sql, type AnyColumn } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import {
  exports as exportFiles,
  materialPages,
  materials,
  materialUploads,
  schoolTemplates,
  solverSessions,
} from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { APP_STORAGE_CAP_BYTES, TEACHER_STORAGE_CAP_BYTES } from "./limits";
import { err, ok, type Result } from "@/lib/result";

// The app-wide storage total (ADR-0022). Cloudflare R2 has no spending cap, so the app refuses new
// files itself once the bytes it tracks reach 6 GiB. Nothing is counted in a counter that could
// drift: the total is summed from the rows that name stored objects, on demand, so every delete
// (account cascade, purge, export expiry, photo sweep) lowers it by itself.
//
// What is summed, over every owner:
//   materials          size_bytes of every row (trashed ones too, until purged)
//   pages              material_pages.image_bytes (the OCR page images kept)
//   uploads            material_uploads.size_bytes of EVERY row, live or expired and not yet
//                      swept: the staging object exists until the sweep (the per-teacher figure
//                      counts live ones only)
//   exports            exports.size_bytes of every stored file, the ZIP included
//   logos              school_templates.logo_bytes while the row exists (trashed ones too)
//   photos             solver_sessions.input_bytes while input_key is not null
// A null size counts as 0 (rows from before the columns existed). Orphan objects (a failed
// cleanup, a PUT after its reservation was swept) are invisible to it: the 6 GiB cap leaves
// headroom under the provider's free allowance and the bucket lifecycle rules are the backstop.

export { APP_STORAGE_CAP_BYTES };

/** The structural database type of the services (a connection or a transaction). */
export type AppTotalDb = PgAsyncDatabase<PgQueryResultHKT, AnyRelations>;

/** Who asked for room (a field of the refusal's log line; never an owner or a file). */
export type StorageWriter = "materials" | "solver" | "logo" | "export" | "ocr";

export interface AppStorageUsage {
  usedBytes: number;
  capBytes: number;
  parts: {
    materials: number;
    pages: number;
    uploads: number;
    exports: number;
    logos: number;
    photos: number;
  };
}

type Part = keyof AppStorageUsage["parts"];

const total = (column: AnyColumn) => sql<string>`coalesce(sum(${column}), 0)::text`;

interface Scope {
  /** One teacher's rows only (default: every owner's). */
  ownerId?: string;
  /** Which upload reservations count: every row, the live ones at `now`, or none. */
  uploads: "all" | "live" | "none";
  now?: Date;
}

/** The six sources, in one statement (one snapshot, so the parts agree), for one scope. */
async function sumParts(db: AppTotalDb, scope: Scope): Promise<AppStorageUsage["parts"]> {
  const { ownerId } = scope;
  const part = (name: Part) => sql<string>`${name}::text`.as("part");
  const of = (column: AnyColumn) =>
    ownerId === undefined ? undefined : eq(column, ownerId);
  const uploadsFilter =
    scope.uploads === "none"
      ? sql`false`
      : scope.uploads === "live"
        ? gt(materialUploads.expiresAt, scope.now ?? new Date())
        : undefined;
  const rows = await unionAll(
    db
      .select({ part: part("materials"), bytes: total(materials.sizeBytes).as("bytes") })
      .from(materials)
      .where(of(materials.ownerId)),
    db
      .select({ part: part("pages"), bytes: total(materialPages.imageBytes).as("bytes") })
      .from(materialPages)
      .where(of(materialPages.ownerId)),
    db
      .select({
        part: part("uploads"),
        bytes: total(materialUploads.sizeBytes).as("bytes"),
      })
      .from(materialUploads)
      .where(and(of(materialUploads.ownerId), uploadsFilter)),
    db
      .select({ part: part("exports"), bytes: total(exportFiles.sizeBytes).as("bytes") })
      .from(exportFiles)
      .where(of(exportFiles.ownerId)),
    db
      .select({
        part: part("logos"),
        bytes: total(schoolTemplates.logoBytes).as("bytes"),
      })
      .from(schoolTemplates)
      .where(of(schoolTemplates.ownerId)),
    db
      .select({
        part: part("photos"),
        bytes: total(solverSessions.inputBytes).as("bytes"),
      })
      .from(solverSessions)
      .where(
        and(of(solverSessions.ownerId), sql`${solverSessions.inputKey} is not null`),
      ),
  );
  const parts: AppStorageUsage["parts"] = {
    materials: 0,
    pages: 0,
    uploads: 0,
    exports: 0,
    logos: 0,
    photos: 0,
  };
  for (const row of rows) parts[row.part as Part] = Number(row.bytes);
  return parts;
}

const sumOf = (parts: AppStorageUsage["parts"]) =>
  Object.values(parts).reduce((sum, bytes) => sum + bytes, 0);

/** The sum of the six sources over every owner, in one statement. */
export async function appStorageUsage(db: AppTotalDb): Promise<AppStorageUsage> {
  const parts = await sumParts(db, { uploads: "all" });
  return { usedBytes: sumOf(parts), capBytes: APP_STORAGE_CAP_BYTES, parts };
}

/**
 * Bytes one teacher keeps in storage, whatever the file is (ADR-0022, security review F1): every
 * material's file (trashed ones until purged), the OCR page images, the exports, the template
 * logos (trashed templates until purged) and the solver photos not yet swept. Upload reservations
 * are not in it (see ownerStorageBytes). This is the figure of the teacher's meter.
 */
export async function ownerStoredBytes(db: AppTotalDb, ownerId: string): Promise<number> {
  return sumOf(await sumParts(db, { ownerId, uploads: "none" }));
}

/** ownerStoredBytes plus the teacher's live upload reservations at `now`: what must fit the cap. */
export async function ownerStorageBytes(
  db: AppTotalDb,
  ownerId: string,
  now: Date,
): Promise<number> {
  return sumOf(await sumParts(db, { ownerId, uploads: "live", now }));
}

/**
 * Whether `extraBytes` more fit under the per-teacher cap (TEACHER_STORAGE_CAP_BYTES, 300 MB).
 * Exactly the cap passes. A writer calls it inside its own transaction, under its per-owner lock
 * where it has one; the export job calls it without (best effort, one export).
 */
export async function assertOwnerStorageRoom(
  db: AppTotalDb,
  input: { ownerId: string; extraBytes: number; now: Date },
): Promise<Result<{ usedBytes: number }, "quota">> {
  const usedBytes = await ownerStorageBytes(db, input.ownerId, input.now);
  if (
    !Number.isSafeInteger(input.extraBytes) ||
    input.extraBytes < 0 ||
    usedBytes + input.extraBytes > TEACHER_STORAGE_CAP_BYTES
  ) {
    return err("quota");
  }
  return ok({ usedBytes });
}

/** How long a reservation may wait for the app-wide lock before it gives up (a retry). */
export const APP_LOCK_TIMEOUT_MS = 3_000;

/** The app-wide lock was not free within APP_LOCK_TIMEOUT_MS: nothing was written, try again. */
export class AppStorageBusyError extends Error {
  constructor() {
    super("The app-wide storage lock is busy; try again in a moment.");
    this.name = "AppStorageBusyError";
  }
}

function pgCode(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Object; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return "";
}

/**
 * Serialises every reservation against the app-wide cap (a transaction advisory lock, freed at
 * commit). ONE FIXED ORDER, so there is no deadlock: a writer takes its own locks first (the
 * per-owner lock, a row lock) and this one LAST, and nothing ever waits for another lock while
 * holding it. Hold it only for the check and the row write, never across a network call (the logo
 * upload puts its object before taking it). Waits at most APP_LOCK_TIMEOUT_MS, then throws
 * AppStorageBusyError (the transaction is aborted, nothing is written); the timeout is reset
 * after the lock is held, so later statements of the transaction are not bounded by it. Job
 * writers (exports, OCR page images) do not take it (see assertAppStorageRoom).
 */
export async function lockAppStorage(tx: AppTotalDb): Promise<void> {
  await tx.execute(
    sql.raw(`set local lock_timeout = '${String(APP_LOCK_TIMEOUT_MS)}ms'`),
  );
  try {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('app_storage_cap', 0))`,
    );
  } catch (error) {
    if (pgCode(error) === "55P03") throw new AppStorageBusyError();
    throw error;
  }
  await tx.execute(sql.raw("set local lock_timeout = 0"));
}

/**
 * Whether `extraBytes` more fit under the cap (`used + extra <= cap`: exactly the cap passes, one
 * byte more is `appFull`). A reservation writer calls it right after lockAppStorage, in its own
 * transaction, so two near the cap cannot both pass. A job writer calls it without the lock (best
 * effort: the race is bounded by one export or one page image, far inside the headroom). A refusal
 * writes one warn line (the writer, the tracked total and the cap: no owner, file or address and
 * no audit row, so a flood of refusals cannot flood the table). A size that is not a non-negative
 * safe integer is refused (fail closed).
 */
export async function assertAppStorageRoom(
  db: AppTotalDb,
  extraBytes: number,
  writer: StorageWriter,
): Promise<Result<{ usedBytes: number }, "appFull">> {
  const { usedBytes, capBytes } = await appStorageUsage(db);
  if (
    !Number.isSafeInteger(extraBytes) ||
    extraBytes < 0 ||
    usedBytes + extraBytes > capBytes
  ) {
    logger.warn(
      { module: "storage", writer, usedBytes, capBytes },
      "storage: the app-wide cap refused a new upload",
    );
    return err("appFull");
  }
  return ok({ usedBytes });
}
