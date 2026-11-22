import "server-only";
import { sql, type AnyColumn } from "drizzle-orm";
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

/** The most the app may store, in all, before every new file is refused: 6 GiB. */
export const APP_STORAGE_CAP_BYTES = 6 * 1024 ** 3;

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

/** The sum of the six sources, in one statement (one snapshot, so the parts agree). */
export async function appStorageUsage(db: AppTotalDb): Promise<AppStorageUsage> {
  const part = (name: Part) => sql<string>`${name}::text`.as("part");
  const rows = await unionAll(
    db
      .select({ part: part("materials"), bytes: total(materials.sizeBytes).as("bytes") })
      .from(materials),
    db
      .select({ part: part("pages"), bytes: total(materialPages.imageBytes).as("bytes") })
      .from(materialPages),
    db
      .select({
        part: part("uploads"),
        bytes: total(materialUploads.sizeBytes).as("bytes"),
      })
      .from(materialUploads),
    db
      .select({ part: part("exports"), bytes: total(exportFiles.sizeBytes).as("bytes") })
      .from(exportFiles),
    db
      .select({
        part: part("logos"),
        bytes: total(schoolTemplates.logoBytes).as("bytes"),
      })
      .from(schoolTemplates),
    db
      .select({
        part: part("photos"),
        bytes: total(solverSessions.inputBytes).as("bytes"),
      })
      .from(solverSessions)
      .where(sql`${solverSessions.inputKey} is not null`),
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
  const usedBytes = Object.values(parts).reduce((sum, bytes) => sum + bytes, 0);
  return { usedBytes, capBytes: APP_STORAGE_CAP_BYTES, parts };
}

/**
 * Serialises every reservation against the app-wide cap (a transaction advisory lock, freed at
 * commit). ONE FIXED ORDER, so there is no deadlock: a writer takes its own locks first (the
 * per-owner lock, a row lock) and this one LAST, and nothing ever waits for another lock while
 * holding it. Job writers (exports, OCR page images) do not take it (see assertAppStorageRoom).
 */
export async function lockAppStorage(tx: AppTotalDb): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('app_storage_cap', 0))`,
  );
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
