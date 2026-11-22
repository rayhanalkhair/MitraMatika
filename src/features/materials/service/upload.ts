import "server-only";
import { createHash } from "node:crypto";
import { and, asc, count, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import { folders, materialPages, materials, materialUploads } from "@/lib/db/schema";
import { createJobQueue } from "@/lib/jobs/queue";
import { logger } from "@/lib/logger";
import { err, ok, type Result } from "@/lib/result";
import { stripImageMetadata } from "@/lib/images/strip-metadata";
import { assertSafeKey, type ObjectStore } from "@/lib/storage/types";
import {
  extensionOf,
  FINALIZE_WINDOW_MS,
  INGEST_MATERIAL_JOB,
  MATERIAL_TYPES,
  MAX_MATERIAL_BYTES,
  MAX_PENDING_UPLOADS,
  MAX_TITLE_LENGTH,
  STORAGE_CAP_BYTES,
  UPLOAD_URL_SECONDS,
  type FinalizeUploadError,
  type MaterialExt,
  type StartUploadError,
} from "../schema/upload";
import { validateMaterialFile } from "./validate";

// The upload flow of decision 2: startUpload checks the declared name, type and size and the
// storage cap, records the upload (material_uploads) and signs a PUT for its exact size; the
// browser sends the file straight to the store; finalizeUpload checks what actually arrived and
// turns the upload into a material. Everything runs on the service connection with explicit owner
// filters (Ruling R9 pattern): material_uploads and the server-only columns of materials are never
// written by the teacher's role.

export type MaterialDb = PgAsyncDatabase<PgQueryResultHKT, AnyRelations>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (value: string) => UUID.test(value);
/** Expired reservations one start may clean up (bounded, so a start stays quick). */
const SWEEP_LIMIT = 5;
const INGEST_MAX_ATTEMPTS = 3;

// Two prefixes, ids only (Ruling R13). The browser PUTs to `uploads/` (staging): its signed URL
// stays valid for up to 5 minutes, even after finalise. Finalise writes the bytes it validated to
// `materials/` under a key no URL was ever signed for, so nothing can replace a material's file.
type Root = "uploads" | "materials";

function sourceKey(root: Root, ownerId: string, id: string, ext: MaterialExt): string {
  if (!isUuid(ownerId) || !isUuid(id)) {
    throw new Error("materials: owner and upload ids must be lower-case uuids");
  }
  const key = `${root}/${ownerId}/${id}/source.${ext}`;
  assertSafeKey(key);
  return key;
}

/**
 * Bytes the owner keeps in storage: every material's file (trashed ones too, until purged) and the
 * page images OCR kept for them (material_pages.image_bytes).
 */
export async function storedBytes(db: MaterialDb, ownerId: string): Promise<number> {
  const [files] = await db
    .select({ bytes: sql<string>`coalesce(sum(${materials.sizeBytes}), 0)` })
    .from(materials)
    .where(eq(materials.ownerId, ownerId));
  const [images] = await db
    .select({ bytes: sql<string>`coalesce(sum(${materialPages.imageBytes}), 0)` })
    .from(materialPages)
    .where(eq(materialPages.ownerId, ownerId));
  return Number(files.bytes) + Number(images.bytes);
}

/** Where the browser uploads (staging; the only key a PUT URL is ever signed for). */
export const uploadStagingKey = (ownerId: string, uploadId: string, ext: MaterialExt) =>
  sourceKey("uploads", ownerId, uploadId, ext);
/** A material's validated original file (written by finalise only, never signed for a PUT). */
export const materialSourceKey = (
  ownerId: string,
  materialId: string,
  ext: MaterialExt,
) => sourceKey("materials", ownerId, materialId, ext);

function isOwnKey(root: Root, ownerId: string, key: string): boolean {
  if (!isUuid(ownerId) || !key.startsWith(`${root}/${ownerId}/`)) return false;
  try {
    assertSafeKey(key);
    return true;
  } catch {
    return false;
  }
}

/** Whether a key sits under the owner's own staging prefix (checked before finalise or a delete). */
export const isOwnUploadKey = (ownerId: string, key: string) =>
  isOwnKey("uploads", ownerId, key);
/** Whether a key sits under the owner's own materials prefix (checked before any delete). */
export const isOwnMaterialKey = (ownerId: string, key: string) =>
  isOwnKey("materials", ownerId, key);

async function deleteQuietly(
  store: ObjectStore,
  ownerId: string,
  key: string,
): Promise<boolean> {
  if (!isOwnUploadKey(ownerId, key) && !isOwnMaterialKey(ownerId, key)) return false;
  try {
    await store.delete(key);
    return true;
  } catch (error) {
    logger.warn(
      { module: "materials", err: error instanceof Error ? error.name : typeof error },
      "materials: could not delete an uploaded object",
    );
    return false;
  }
}

function lockOwner(tx: MaterialDb, ownerId: string) {
  return tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`material_upload:${ownerId}`}, 0))`,
  );
}

/** Which stored type a file name and declared type ask for, or why they are refused. */
function resolveType(
  fileName: string,
  declaredType: string,
): Result<MaterialExt, "type" | "doc"> {
  const ext = extensionOf(fileName);
  if (ext === "doc" || declaredType === "application/msword") return err("doc");
  if (ext === null) return err("type");
  // Some browsers declare nothing; a declared type must agree with the name.
  if (declaredType !== "" && declaredType !== MATERIAL_TYPES[ext].mime)
    return err("type");
  return ok(ext);
}

/**
 * Starts an upload: checks the declared name, type and size and the owner's storage cap (stored
 * materials, trashed ones until purged, plus live reservations), records the reservation and
 * returns a PUT URL signed for exactly `size` bytes of the canonical content type, valid for
 * UPLOAD_URL_SECONDS. Serialised per owner by an advisory lock, so two starts cannot both fit
 * under the cap. Expired reservations of the owner are cleaned up first (object, then row).
 */
export async function startUpload(
  db: MaterialDb,
  store: ObjectStore,
  input: {
    ownerId: string;
    fileName: string;
    declaredType: string;
    size: number;
    now: Date;
  },
): Promise<
  Result<{ uploadUrl: string; objectKey: string; contentType: string }, StartUploadError>
> {
  const { ownerId, size, now } = input;
  const type = resolveType(input.fileName, input.declaredType);
  if (!type.ok) return type;
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_MATERIAL_BYTES) {
    return err("size");
  }
  const ext = type.data;
  const { kind, mime } = MATERIAL_TYPES[ext];

  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as MaterialDb;
    await lockOwner(tx, ownerId);

    const expired = await tx
      .select({ id: materialUploads.id, objectKey: materialUploads.objectKey })
      .from(materialUploads)
      .where(
        and(
          eq(materialUploads.ownerId, ownerId),
          lte(materialUploads.expiresAt, now),
          // A finalise still checking this upload keeps it.
          or(
            isNull(materialUploads.claimedAt),
            lte(materialUploads.claimedAt, new Date(now.getTime() - CLAIM_TTL_MS)),
          ),
        ),
      )
      .orderBy(asc(materialUploads.expiresAt))
      .limit(SWEEP_LIMIT);
    for (const row of expired) {
      // A row whose object could not be deleted stays for the next start.
      if (await deleteQuietly(store, ownerId, row.objectKey)) {
        await tx.delete(materialUploads).where(eq(materialUploads.id, row.id));
      }
    }

    const [pending] = await tx
      .select({
        uploads: count(),
        bytes: sql<string>`coalesce(sum(${materialUploads.sizeBytes}), 0)`,
      })
      .from(materialUploads)
      .where(
        and(eq(materialUploads.ownerId, ownerId), gt(materialUploads.expiresAt, now)),
      );
    if (pending.uploads >= MAX_PENDING_UPLOADS) return err<StartUploadError>("pending");
    const stored = await storedBytes(tx, ownerId);
    if (stored + Number(pending.bytes) + size > STORAGE_CAP_BYTES) {
      return err<StartUploadError>("quota");
    }

    const uploadId = crypto.randomUUID();
    const objectKey = uploadStagingKey(ownerId, uploadId, ext);
    await tx.insert(materialUploads).values({
      id: uploadId,
      ownerId,
      objectKey,
      kind,
      mime,
      sizeBytes: size,
      expiresAt: new Date(now.getTime() + FINALIZE_WINDOW_MS),
      createdAt: now,
    });
    const uploadUrl = await store.signedPutUrl(objectKey, mime, size, UPLOAD_URL_SECONDS);
    return ok({ uploadUrl, objectKey, contentType: mime });
  });
}

/** A claim older than this is taken over (its finalise died); longer than any honest check. */
export const CLAIM_TTL_MS = 5 * 60_000;

/** Deletes the reservation if this claim still holds it; true when it did. */
async function dropClaimed(
  db: MaterialDb,
  uploadId: string,
  token: string,
): Promise<boolean> {
  const rows = await db
    .delete(materialUploads)
    .where(and(eq(materialUploads.id, uploadId), eq(materialUploads.claimToken, token)))
    .returning({ id: materialUploads.id });
  return rows.length === 1;
}

/**
 * Turns a finished upload into a material, in three steps so no transaction is open while the
 * file is downloaded and checked:
 * 1. Claim (short transaction, row lock): only a staging key that startUpload issued to this owner,
 *    still reserved and not claimed by another finalise, is accepted; anything else is notFound and
 *    nothing is deleted (another teacher's object is never touched). An expired reservation is
 *    dropped with its object.
 * 2. Outside any transaction: download the staging object (at most MAX_MATERIAL_BYTES, read whole:
 *    pdf.js needs the whole PDF anyway), check the exact size and the file itself (decision 1; a
 *    PDF in a bounded worker, R10). Bytes that have not arrived yet release the claim (`missing`,
 *    retry later). Any failed check drops the reservation and deletes the staging object.
 * 3. Write the validated bytes to the material's own key (`materials/`, never signed for a PUT),
 *    then in one short transaction: consume the reservation (still ours?), create the material
 *    (id = upload id, status uploaded, sha-256 of those bytes) and queue `ingest_material`. The
 *    staging object is deleted afterwards. A late PUT through the still-valid URL only rewrites
 *    the staging key, which can no longer be finalised (the `uploads/` lifecycle rule removes it).
 * A thrown error after the claim deletes the final copy (if written), the staging object and the
 * reservation, then rethrows: the teacher uploads again.
 * Title and folder mistakes are refused before the claim and keep the upload.
 */
export async function finalizeUpload(
  db: MaterialDb,
  store: ObjectStore,
  input: {
    ownerId: string;
    objectKey: string;
    title: string;
    folderId?: string;
    now: Date;
    /** How long the PDF check may wait for the process's parse slot (R29). */
    parseWaitMs?: number;
  },
): Promise<Result<{ materialId: string }, FinalizeUploadError>> {
  const { ownerId, objectKey, now } = input;
  const title = input.title.trim();
  if (title.length === 0 || Array.from(title).length > MAX_TITLE_LENGTH)
    return err("title");
  const folderId = input.folderId === "" ? undefined : input.folderId;
  if (folderId !== undefined && !isUuid(folderId)) return err("folder");
  if (!isOwnUploadKey(ownerId, objectKey)) return err("notFound");
  if (folderId !== undefined) {
    const folder = await db
      .select({ id: folders.id })
      .from(folders)
      .where(
        and(
          eq(folders.id, folderId),
          eq(folders.ownerId, ownerId),
          isNull(folders.deletedAt),
        ),
      );
    if (folder.length === 0) return err("folder");
  }

  // 1. Claim.
  const token = crypto.randomUUID();
  const claim = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as MaterialDb;
    const upload = (
      await tx
        .select()
        .from(materialUploads)
        .where(
          and(
            eq(materialUploads.ownerId, ownerId),
            eq(materialUploads.objectKey, objectKey),
          ),
        )
        .for("update")
    ).at(0);
    // A cancelled upload is never finalised (its URL may have been used after the cancel).
    if (!upload || upload.cancelledAt) return { state: "none" as const };
    if (upload.claimedAt && upload.claimedAt.getTime() > now.getTime() - CLAIM_TTL_MS) {
      return { state: "none" as const };
    }
    if (upload.expiresAt.getTime() <= now.getTime()) {
      await tx.delete(materialUploads).where(eq(materialUploads.id, upload.id));
      return { state: "expired" as const };
    }
    await tx
      .update(materialUploads)
      .set({ claimToken: token, claimedAt: now })
      .where(eq(materialUploads.id, upload.id));
    return { state: "claimed" as const, upload };
  });
  if (claim.state === "none") return err("notFound");
  if (claim.state === "expired") {
    await deleteQuietly(store, ownerId, objectKey);
    return err("expired");
  }
  const { upload } = claim;

  const reject = async (reason: FinalizeUploadError) => {
    await dropClaimed(db, upload.id, token);
    await deleteQuietly(store, ownerId, objectKey);
    return err(reason);
  };

  let finalKey: string | null = null;
  try {
    // 2. Download and check, outside any transaction.
    const bytes = await store.get(objectKey);
    if (!bytes) {
      await db
        .update(materialUploads)
        .set({ claimToken: null, claimedAt: null })
        .where(
          and(eq(materialUploads.id, upload.id), eq(materialUploads.claimToken, token)),
        );
      return err("missing");
    }
    if (bytes.length !== upload.sizeBytes) return await reject("size");
    const ext = extensionOf(`x.${objectKey.slice(objectKey.lastIndexOf(".") + 1)}`);
    if (ext === null || ext === "doc") return await reject("type");
    const checked = await validateMaterialFile(bytes, ext, {
      ownerId,
      parseWaitMs: input.parseWaitMs,
    });
    if (!checked.ok && checked.error === "busy") {
      // Another parse held this process's slot (R29): nothing was checked, keep the upload.
      await db
        .update(materialUploads)
        .set({ claimToken: null, claimedAt: null })
        .where(
          and(eq(materialUploads.id, upload.id), eq(materialUploads.claimToken, token)),
        );
      return err("busy");
    }
    if (!checked.ok) return await reject(checked.error);
    // A photo keeps no metadata (Exif GPS, device, time): the stripped bytes are what is stored,
    // hashed and counted, so ingestion's sha-256 check holds.
    let kept = bytes;
    if (checked.data.kind === "image") {
      const clean = stripImageMetadata(
        bytes,
        checked.data.mime === "image/png" ? "image/png" : "image/jpeg",
      );
      if (!clean) return await reject("image");
      kept = clean;
    }

    // 3. Final copy, then the material.
    const sourceKey = materialSourceKey(ownerId, upload.id, ext);
    await store.put(sourceKey, kept, checked.data.mime);
    finalKey = sourceKey;
    const created = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as MaterialDb;
      // The claim may have been taken over after CLAIM_TTL_MS; then the other finalise owns it.
      if (!(await dropClaimed(tx, upload.id, token))) return false;
      await tx.insert(materials).values({
        id: upload.id,
        ownerId,
        folderId: folderId ?? null,
        title,
        kind: checked.data.kind,
        mime: checked.data.mime,
        sizeBytes: kept.length,
        sha256: createHash("sha256").update(kept).digest("hex"),
        objectKey: sourceKey,
        pageCount: checked.data.pageCount,
        status: "uploaded",
        createdAt: now,
        updatedAt: now,
      });
      await createJobQueue(tx, () => now).enqueue({
        ownerId,
        type: INGEST_MATERIAL_JOB,
        payload: { materialId: upload.id },
        runAfter: now,
        maxAttempts: INGEST_MAX_ATTEMPTS,
      });
      return true;
    });
    // Lost the claim: leave both objects to the finalise that holds it.
    if (!created) return err("notFound");
  } catch (error) {
    if (finalKey !== null) await deleteQuietly(store, ownerId, finalKey);
    await deleteQuietly(store, ownerId, objectKey);
    try {
      await dropClaimed(db, upload.id, token);
    } catch {
      // The sweep takes the reservation once the claim is stale.
    }
    throw error;
  }
  await deleteQuietly(store, ownerId, objectKey);
  return ok({ materialId: upload.id });
}

/**
 * The teacher cancels an upload that was not finalised (unless a finalise holds a fresh claim on
 * it): the reservation is marked cancelled, so it can never be finalised but still counts toward
 * the caps until it expires, and the staging object is deleted. Another teacher's key, or one
 * already cancelled or finalised, is notFound and nothing is touched.
 */
export async function cancelUpload(
  db: MaterialDb,
  store: ObjectStore,
  input: { ownerId: string; objectKey: string; now: Date },
): Promise<Result<void, "notFound">> {
  const { ownerId, objectKey, now } = input;
  if (!isOwnUploadKey(ownerId, objectKey)) return err("notFound");
  const stale = new Date(now.getTime() - CLAIM_TTL_MS);
  // Marked, not deleted: the signed PUT URL stays valid for minutes, so the reservation keeps
  // counting toward the pending and storage caps until it expires; the sweep then removes the row
  // and any object a late PUT left behind.
  const cancelled = await db
    .update(materialUploads)
    .set({ cancelledAt: now })
    .where(
      and(
        eq(materialUploads.ownerId, ownerId),
        eq(materialUploads.objectKey, objectKey),
        isNull(materialUploads.cancelledAt),
        or(isNull(materialUploads.claimedAt), lte(materialUploads.claimedAt, stale)),
      ),
    )
    .returning({ id: materialUploads.id });
  if (cancelled.length === 0) return err("notFound");
  await deleteQuietly(store, ownerId, objectKey);
  return ok();
}
