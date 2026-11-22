import "server-only";
import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { fileTypeFromBuffer } from "file-type";
import { runAsUser } from "@/lib/db/client";
import { schoolTemplates } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { jpegSize, pngSize } from "@/lib/images/dimensions";
import { err, ok, type Result } from "@/lib/result";
import type { ObjectStore } from "@/lib/storage/types";
import { assertSafeKey } from "@/lib/storage/types";
import { MAX_LOGO_BYTES, MAX_LOGO_SIDE, type LogoErrorKey } from "../schema/template";
import { sanitizeSvg } from "./svg-sanitize";
import { isUuid, type TemplateDb } from "./templates";

export { sanitizeSvg } from "./svg-sanitize";

// The school logo of a template: PNG, JPEG or SVG up to 1 MB (decision 7), kept in the object
// store under templates/<owner>/<template>/logo.<ext>. What the file IS comes from its bytes
// (magic numbers, file-type; an SVG by parsing it), never from its name or the type the browser
// declared. An SVG is stored only as the sanitised rebuild.

export { MAX_LOGO_BYTES, MAX_LOGO_SIDE };

export type LogoExt = "png" | "jpg" | "svg";
const CONTENT_TYPES: Record<LogoExt, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  svg: "image/svg+xml",
};

export interface ValidLogo {
  ext: LogoExt;
  contentType: string;
  bytes: Uint8Array;
  /** The browser declared another type than the bytes show (informational only). */
  declaredMismatch: boolean;
}

type ValidationError = Exclude<LogoErrorKey, "notFound" | "unauthenticated" | "generic">;

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Decides what the uploaded bytes are. PNG and JPEG by their magic numbers (and a header size of
 * at most MAX_LOGO_SIDE per side); text that is not a known binary type must parse as an SVG and
 * is replaced by its sanitised rebuild. Everything else (an executable renamed .png, GIF, WebP,
 * HTML) is refused. The declared type never decides.
 */
export async function validateLogo(
  bytes: Uint8Array,
  declaredType: string,
): Promise<Result<ValidLogo, ValidationError>> {
  if (bytes.length === 0) return err("empty");
  if (bytes.length > MAX_LOGO_BYTES) return err("tooLarge");

  const detected = await fileTypeFromBuffer(bytes);
  const accept = (ext: LogoExt, body: Uint8Array) =>
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
    if (!text?.includes("<")) return err("unsupportedType");
    const svg = sanitizeSvg(text);
    if (!svg.ok) return err("invalidImage");
    return accept("svg", new TextEncoder().encode(svg.data));
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
export async function uploadLogo(
  store: ObjectStore,
  db: TemplateDb,
  input: { ownerId: string; templateId: string; bytes: Uint8Array; declaredType: string },
): Promise<Result<{ logoKey: string }, ValidationError | "notFound">> {
  const { ownerId, templateId } = input;
  if (!isUuid(templateId)) return err("notFound");
  const valid = await validateLogo(input.bytes, input.declaredType);
  if (!valid.ok) return valid;

  const key = logoKey(ownerId, templateId, valid.data.ext);
  // Set inside the transaction callback.
  const progress: { stored: boolean; previousKey: string | null } = {
    stored: false,
    previousKey: null,
  };
  try {
    // The service connection (Ruling R9 pattern): the authenticated role may not write logo_key, so
    // the owner and template are named in every statement instead of relying on RLS.
    const saved = await db.transaction(async (tx) => {
      const row = (
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
          .for("update")
      ).at(0);
      if (!row) return false;
      // Only an object of this template may be replaced (and later deleted).
      progress.previousKey = ownLogoKeyOrNull(ownerId, templateId, row.logoKey);
      await store.put(key, valid.data.bytes, valid.data.contentType);
      progress.stored = true;
      await tx
        .update(schoolTemplates)
        .set({
          logoKey: key,
          // What an approval's hash covers (Ruling R26): a same-format replacement keeps the key.
          logoSha256: logoSha256(valid.data.bytes),
          rowVersion: sql`${schoolTemplates.rowVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(eq(schoolTemplates.id, templateId), eq(schoolTemplates.ownerId, ownerId)),
        );
      return true;
    });
    if (!saved) return err("notFound");
  } catch (error) {
    // The row still points at the previous logo: remove the new object unless it replaced it.
    if (progress.stored && key !== progress.previousKey) await deleteQuietly(store, key);
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
