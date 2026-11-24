import "server-only";
import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { fileTypeFromBuffer } from "file-type";
import { runAsUser } from "@/lib/db/client";
import { schoolTemplates } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { jpegSize, pngSize } from "@/lib/images/dimensions";
import { err, ok, type Result } from "@/lib/result";
import {
  assertAppStorageRoom,
  assertOwnerStorageRoom,
  lockAppStorage,
  withAppStorageBusy,
} from "@/lib/storage/app-total";
import type { ObjectStore } from "@/lib/storage/types";
import { assertSafeKey } from "@/lib/storage/types";
import { MAX_LOGO_BYTES, MAX_LOGO_SIDE, type LogoErrorKey } from "../schema/template";
import { isUuid, type TemplateDb } from "./templates";

export { sanitizeSvg } from "./svg-sanitize";

// The school logo of a template: PNG or JPEG up to 1 MB (decision 7; the owner ruled on 22 Nov
// that SVG is not accepted), kept in the object store under templates/<owner>/<template>/logo.<ext>.
// What the file IS comes from its bytes (magic numbers, file-type), never from its name or the
// type the browser declared. An SVG logo stored before that ruling stays and is still served (so
// LogoExt keeps "svg" and CONTENT_TYPES maps it); the PDF and Word files leave it out with a warning.

export { MAX_LOGO_BYTES, MAX_LOGO_SIDE };

export type LogoExt = "png" | "jpg" | "svg";
const CONTENT_TYPES: Record<LogoExt, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  svg: "image/svg+xml",
};

export interface ValidLogo {
  ext: "png" | "jpg";
  contentType: string;
  bytes: Uint8Array;
  /** The browser declared another type than the bytes show (informational only). */
  declaredMismatch: boolean;
}

type ValidationError = Exclude<
  LogoErrorKey,
  "notFound" | "unauthenticated" | "generic" | "appFull" | "storageBusy" | "quota"
>;

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Decides what the uploaded bytes are. PNG and JPEG by their magic numbers (and a header size of
 * at most MAX_LOGO_SIDE per side). An SVG is recognised by its text and refused with its own
 * message (`svgNotAccepted`); everything else (an executable renamed .png, GIF, WebP, HTML) is
 * refused as an unsupported type. The declared type never decides.
 */
export async function validateLogo(
  bytes: Uint8Array,
  declaredType: string,
): Promise<Result<ValidLogo, ValidationError>> {
  if (bytes.length === 0) return err("empty");
  if (bytes.length > MAX_LOGO_BYTES) return err("tooLarge");

  const detected = await fileTypeFromBuffer(bytes);
  const accept = (ext: ValidLogo["ext"], body: Uint8Array) =>
    ok({
      ext,
      contentType: CONTENT_TYPES[ext],
      bytes: body,
      declaredMismatch: declaredType !== CONTENT_TYPES[ext],
    });

  if (detected?.ext === "png" || detected?.ext === "jpg") {
    const size = detected.ext === "png" ? pngSize(bytes) : jpegSize(bytes);
    if (!size || size.width === 0 || size.height === 0) return err("invalidImage");
    if (size.width > MAX_LOGO_SIDE || size.height > MAX_LOGO_SIDE) {
      return err("dimensionsTooLarge");
    }
    return accept(detected.ext, bytes);
  }

  // file-type does not detect SVG (text); it reports "xml" when there is an XML declaration.
  if (detected === undefined || detected.ext === "xml") {
    const text = decodeUtf8(bytes);
    if (text !== null && /<svg[\s>]/i.test(text)) return err("svgNotAccepted");
  }
  return err("unsupportedType");
}

/** The sha-256 (hex) of a logo's stored bytes, as school_templates.logo_sha256 records it. */
export function logoSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The object key of a template's logo: ids only, never a name or an email address. */
export function logoKey(ownerId: string, templateId: string, ext: LogoExt): string {
  const key = `templates/${ownerId}/${templateId}/logo.${ext}`;
  assertSafeKey(key);
  if (key.includes("@")) throw new Error("Kunci logo tidak boleh memuat alamat email.");
  return key;
}

/**
 * Whether a stored logo_key belongs to this template: it must sit under the template's own prefix
 * `templates/<ownerId>/<templateId>/` and be a safe key (no "..", no stray slashes). Every path
 * that reads the column to touch storage checks this first, so a rewritten column can never
 * serve or delete another teacher's object.
 */
export function isOwnLogoKey(ownerId: string, templateId: string, key: string): boolean {
  if (!key.startsWith(`templates/${ownerId}/${templateId}/`)) return false;
  try {
    assertSafeKey(key);
    return true;
  } catch {
    return false;
  }
}

/** The stored key when it is the template's own, else null (logged without the key itself). */
export function ownLogoKeyOrNull(
  ownerId: string,
  templateId: string,
  key: string | null | undefined,
): string | null {
  if (!key) return null;
  if (isOwnLogoKey(ownerId, templateId, key)) return key;
  logger.warn(
    { module: "templates", templateId },
    "templates: logo_key outside the template's own prefix; ignored",
  );
  return null;
}

function contentTypeOfKey(key: string): string {
  const ext = key.slice(key.lastIndexOf(".") + 1);
  return ext in CONTENT_TYPES
    ? CONTENT_TYPES[ext as LogoExt]
    : "application/octet-stream";
}

/**
 * Validates and stores a template's logo, then records its key and the sha-256 of the stored
 * bytes (bumping row_version). Runs on the
 * service connection with explicit owner and template filters (only this path may write
 * logo_key): another teacher's template, or a trashed one, is notFound and nothing is stored. A replaced logo with another extension is deleted after the commit.
 */
async function uploadLogoUnguarded(
  store: ObjectStore,
  db: TemplateDb,
  input: { ownerId: string; templateId: string; bytes: Uint8Array; declaredType: string },
): Promise<
  Result<{ logoKey: string }, ValidationError | "notFound" | "appFull" | "quota">
> {
  const { ownerId, templateId } = input;
  if (!isUuid(templateId)) return err("notFound");
  const valid = await validateLogo(input.bytes, input.declaredType);
  if (!valid.ok) return valid;

  const key = logoKey(ownerId, templateId, valid.data.ext);
  // Set inside the transaction callback.
  const progress: {
    stored: boolean;
    previousKey: string | null;
    /** The bytes a same-key upload overwrote, to put back when the write is undone. */
    previousBody: Uint8Array | null;
    full: boolean;
    quota: boolean;
  } = { stored: false, previousKey: null, previousBody: null, full: false, quota: false };
  // Undoes the put of an upload that did not commit: the new object goes, or, when it overwrote
  // the previous logo (same extension, same key), the previous bytes come back.
  const undoPut = async () => {
    if (!progress.stored) return;
    progress.stored = false;
    if (key !== progress.previousKey) return deleteQuietly(store, key);
    if (progress.previousBody === null) return deleteQuietly(store, key);
    try {
      await store.put(key, progress.previousBody, valid.data.contentType);
    } catch (error) {
      logger.warn(
        { module: "templates", err: error instanceof Error ? error.name : typeof error },
        "templates: could not restore the previous logo object",
      );
    }
  };
  try {
    // The service connection (Ruling R9 pattern): the authenticated role may not write logo_key, so
    // the owner and template are named in every statement instead of relying on RLS.
    const saved = await db.transaction(async (tx) => {
      const row = (
        await tx
          .select({
            logoKey: schoolTemplates.logoKey,
            logoBytes: schoolTemplates.logoBytes,
          })
          .from(schoolTemplates)
          .where(
            and(
              eq(schoolTemplates.id, templateId),
              eq(schoolTemplates.ownerId, ownerId),
              isNull(schoolTemplates.deletedAt),
            ),
          )
          .for("update")
      ).at(0);
      if (!row) return false;
      // Only an object of this template may be replaced (and later deleted).
      progress.previousKey = ownLogoKeyOrNull(ownerId, templateId, row.logoKey);
      // The app-wide cap (ADR-0022). A replacement needs only the growth over the logo it
      // replaces. First without the app lock, so a full app stores nothing at all...
      const growth = Math.max(0, valid.data.bytes.length - (row.logoBytes ?? 0));
      // The teacher's own 300 MB first (every kind of file counts, F1), then the app's.
      const own = await assertOwnerStorageRoom(tx, {
        ownerId,
        extraBytes: growth,
        now: new Date(),
      });
      if (!own.ok) {
        progress.quota = true;
        return false;
      }
      const early = await assertAppStorageRoom(tx, growth, "logo");
      if (!early.ok) {
        progress.full = true;
        return false;
      }
      if (key === progress.previousKey) progress.previousBody = await store.get(key);
      // ...then the put, outside the app-wide lock (a slow object store must not stall every
      // other upload), and only then the lock for the authoritative check and the row write: the
      // template row lock is held, so the app lock comes second (one fixed order).
      await store.put(key, valid.data.bytes, valid.data.contentType);
      progress.stored = true;
      await lockAppStorage(tx);
      const room = await assertAppStorageRoom(tx, growth, "logo");
      if (!room.ok) {
        // Lost a race for the last room between the two checks.
        progress.full = true;
        await undoPut();
        return false;
      }
      await tx
        .update(schoolTemplates)
        .set({
          logoKey: key,
          // What an approval's hash covers (Ruling R26): a same-format replacement keeps the key.
          logoSha256: logoSha256(valid.data.bytes),
          // What the app-wide storage total sums (ADR-0022).
          logoBytes: valid.data.bytes.length,
          rowVersion: sql`${schoolTemplates.rowVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(eq(schoolTemplates.id, templateId), eq(schoolTemplates.ownerId, ownerId)),
        );
      return true;
    });
    if (!saved) {
      return err(progress.quota ? "quota" : progress.full ? "appFull" : "notFound");
    }
  } catch (error) {
    // The row still points at the previous logo (a busy app lock included): undo the put.
    await undoPut();
    throw error;
  }

  const { previousKey } = progress;
  if (previousKey !== null && previousKey !== key)
    await deleteQuietly(store, previousKey);
  if (valid.data.declaredMismatch) {
    logger.info(
      { module: "templates", ext: valid.data.ext },
      "templates: logo type differs from the declared type; stored by its bytes",
    );
  }
  return ok({ logoKey: key });
}

/**
 * uploadLogo, answering `storageBusy` when the app-wide storage lock was not free in time. The
 * guard sits OUTSIDE uploadLogoUnguarded on purpose: its catch removes the object it put (or puts
 * the previous bytes back) and rethrows, so the busy error must pass through that cleanup first.
 */
export async function uploadLogo(
  store: ObjectStore,
  db: TemplateDb,
  input: { ownerId: string; templateId: string; bytes: Uint8Array; declaredType: string },
): Promise<
  Result<
    { logoKey: string },
    ValidationError | "notFound" | "appFull" | "quota" | "storageBusy"
  >
> {
  return withAppStorageBusy(() => uploadLogoUnguarded(store, db, input));
}

async function deleteQuietly(store: ObjectStore, key: string): Promise<void> {
  try {
    await store.delete(key);
  } catch (error) {
    logger.warn(
      { module: "templates", err: error instanceof Error ? error.name : typeof error },
      "templates: could not delete a logo object",
    );
  }
}

/** The owner's logo bytes for the owner-checked route; anything else is notFound. */
export async function readLogo(
  store: ObjectStore,
  db: TemplateDb,
  input: { ownerId: string; templateId: string },
): Promise<Result<{ bytes: Uint8Array; contentType: string }, "notFound">> {
  const { ownerId, templateId } = input;
  if (!isUuid(templateId)) return err("notFound");
  const key = await runAsUser(
    db,
    ownerId,
    async (tx) =>
      (
        await tx
          .select({ logoKey: schoolTemplates.logoKey })
          .from(schoolTemplates)
          .where(
            and(
              eq(schoolTemplates.id, templateId),
              eq(schoolTemplates.ownerId, ownerId),
              isNull(schoolTemplates.deletedAt),
            ),
          )
      ).at(0)?.logoKey,
  );
  const own = ownLogoKeyOrNull(ownerId, templateId, key);
  if (!own) return err("notFound");
  const bytes = await store.get(own);
  if (!bytes) return err("notFound");
  return ok({ bytes, contentType: contentTypeOfKey(own) });
}
