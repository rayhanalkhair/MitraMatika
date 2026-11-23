// The storage caps that bound what an account and the whole app may keep (ADR-0022). Plain
// constants with no server-only import, so the browser bundle (the upload meter) and the server
// share ONE definition. Per-file limits stay with their feature (materials 25 MB in
// features/materials/schema/upload.ts, logo 1 MB, photo and page image 2.5 MB, export file 25 MB).

/**
 * What one teacher may keep in all: materials (trashed ones until purged), OCR page images,
 * exports, template logos and solver photos, plus live upload reservations: 300 MB. New files are
 * refused above it; nothing is deleted. The materials feature re-exports it as STORAGE_CAP_BYTES.
 */
export const TEACHER_STORAGE_CAP_BYTES = 300 * 1024 * 1024;

/** The most the whole app may store, in all, before every new file is refused: 6 GiB. */
export const APP_STORAGE_CAP_BYTES = 6 * 1024 ** 3;

/** The most template rows one teacher may keep (trashed ones count until purged). */
export const MAX_TEMPLATES_PER_TEACHER = 20;
