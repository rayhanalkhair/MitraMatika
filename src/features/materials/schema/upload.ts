// What a teacher may upload as a learning material (decision 1 of the materials plan) and the
// typed reasons an upload is refused. Shared by the server (startUpload, finalizeUpload) and the
// browser (the dropzone checks the same limits before it asks for a URL).
import { z } from "zod";

// The one place the upload limits live (ADR-0022): the server (startUpload, finalizeUpload), the
// browser checks and the messages all follow these two numbers. They were 50 MB and 1 GB until
// 22 Nov 2026; the app has no hard spending cap at the storage provider, so these are the cap.
/** At most 25 MB per file (the signed PUT is for the exact size, never more). */
export const MAX_MATERIAL_BYTES = 25 * 1024 * 1024;
/**
 * Stored materials (trashed ones too, until purged), OCR page images and pending uploads, per
 * teacher: 300 MB. It only gates NEW uploads: a teacher already above it keeps and can download
 * every file and can still delete, but startUpload refuses until they are back under it.
 */
export const STORAGE_CAP_BYTES = 300 * 1024 * 1024;
// The app-wide 6 GiB cap (APP_STORAGE_CAP_BYTES) lives in src/lib/storage/app-total.ts: it is
// server-only (this file is also bundled for the browser) and is summed from the database.
export const MAX_PDF_PAGES = 300;
/** A DOCX may inflate to at most 20 times its size and never past 200 MB. */
export const DOCX_INFLATE_RATIO = 20;
export const MAX_DOCX_INFLATED_BYTES = 200 * 1024 * 1024;
/** A Word document has a few dozen parts; thousands mean an archive built to exhaust the reader. */
export const MAX_DOCX_ENTRIES = 1000;
/** Per image side and in all (the vision model scales a page down anyway). */
export const MAX_IMAGE_SIDE = 10_000;
export const MAX_IMAGE_PIXELS = 40_000_000;
/** Lifetime of the signed PUT URL (the store caps every signed URL at 300 s). */
export const UPLOAD_URL_SECONDS = 300;
/**
 * How long a started upload may take to be finalised. Longer than the URL: a slow upload that
 * began before the URL expired may finish after it. After this the reservation no longer counts
 * and the owner's next start deletes it with its object.
 */
export const FINALIZE_WINDOW_MS = 60 * 60_000;
/** Uploads in flight per teacher (each reserves its size against the storage cap). */
export const MAX_PENDING_UPLOADS = 10;
export const MAX_TITLE_LENGTH = 200;
export const INGEST_MATERIAL_JOB = "ingest_material";

/** The extensions a stored material may have; `.jpeg` is stored as `.jpg`. */
export type MaterialExt = "pdf" | "docx" | "jpg" | "png";
export type MaterialKind = "pdf" | "docx" | "image";

export const MATERIAL_TYPES: Record<MaterialExt, { kind: MaterialKind; mime: string }> = {
  pdf: { kind: "pdf", mime: "application/pdf" },
  docx: {
    kind: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  jpg: { kind: "image", mime: "image/jpeg" },
  png: { kind: "image", mime: "image/png" },
};

/** The file input's accept list (extensions and types, so every browser offers the right files). */
export const MATERIAL_ACCEPT = [
  ".pdf",
  ".docx",
  ".jpg",
  ".jpeg",
  ".png",
  ...new Set(Object.values(MATERIAL_TYPES).map((type) => type.mime)),
].join(",");
/** The camera input: JPEG or PNG only (a phone converts its own format to one of them). */
export const CAMERA_ACCEPT = "image/jpeg,image/png";

/** `appFull`: the whole app has reached its storage cap (ADR-0022), whoever the teacher is. */
export type StartUploadError = "type" | "doc" | "size" | "quota" | "pending" | "appFull";
export type FileValidationError =
  "type" | "doc" | "encrypted" | "pages" | "zipBomb" | "image" | "damaged";
/**
 * `busy`: another parse held the process's slot (R29); the upload is kept and finalise can be
 * tried again.
 */
export type FinalizeUploadError =
  | FileValidationError
  | "size"
  | "notFound"
  | "missing"
  | "expired"
  | "title"
  | "folder"
  | "busy";
/** Every message key the upload UI can show under `materials.upload.errors`. */
export type UploadErrorKey =
  StartUploadError | FinalizeUploadError | "network" | "unauthenticated" | "generic";

export const startUploadSchema = z.object({
  fileName: z.string().min(1).max(255),
  declaredType: z.string().max(255),
  size: z.number(),
});

export const finalizeUploadSchema = z.object({
  objectKey: z.string().min(1).max(512),
  title: z.string().max(1000),
  folderId: z.string().optional(),
});

export const cancelUploadSchema = z.object({
  objectKey: z.string().min(1).max(512),
});

export type CancelUploadState =
  { ok: true } | { ok: false; error: "notFound" | "unauthenticated" | "generic" };
export type StartUploadState =
  | { ok: true; uploadUrl: string; objectKey: string; contentType: string }
  | { ok: false; error: UploadErrorKey };
export type FinalizeUploadState =
  { ok: true; materialId: string } | { ok: false; error: UploadErrorKey };

/** The extension a file name maps to, "doc" for an old Word file, null for anything else. */
export function extensionOf(fileName: string): MaterialExt | "doc" | null {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = fileName.slice(dot + 1).toLowerCase();
  if (ext === "jpeg") return "jpg";
  if (ext === "doc") return "doc";
  // Own keys only: "constructor" or "__proto__" are not extensions.
  return Object.hasOwn(MATERIAL_TYPES, ext) ? (ext as MaterialExt) : null;
}

/** A title from the file name: without the extension, trimmed, at most MAX_TITLE_LENGTH. */
export function titleFromFileName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const base = (dot > 0 ? fileName.slice(0, dot) : fileName).trim();
  return Array.from(base).slice(0, MAX_TITLE_LENGTH).join("");
}
