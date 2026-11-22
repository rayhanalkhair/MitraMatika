// The materials library (decision 3 of the materials plan): the list's URL query, folder names and
// the typed reasons a folder or material change is refused. Shared by the server (library.ts) and
// the pages and forms.
import { z } from "zod";

export const MATERIAL_PAGE_SIZE = 20;
export const MATERIAL_STATUSES = [
  "uploaded",
  "processing",
  "needs_review",
  "ready",
  "failed",
] as const;
export type MaterialStatus = (typeof MATERIAL_STATUSES)[number];
export const MAX_FOLDER_NAME = 80;
/** Longer searches are cut, not refused (like the bank). */
export const MAX_SEARCH_LENGTH = 100;
export const ACADEMIC_YEAR = /^(\d{4})\/(\d{4})$/;

/** "2026/2027": four digits, a slash, the next year. */
export function isAcademicYear(value: string): boolean {
  const match = ACADEMIC_YEAR.exec(value);
  return match !== null && Number(match[2]) === Number(match[1]) + 1;
}

// URL params come as a string, or an array when repeated: only the first counts. A param that
// does not parse is dropped (the default applies); the page never errors on a bad link.
const first = (value: unknown): unknown => (Array.isArray(value) ? value[0] : value);
const param = <T extends z.ZodType>(schema: T) =>
  z.preprocess(first, schema.optional().catch(undefined));

export const materialQuerySchema = z.object({
  folder: param(z.uuid()),
  grade: param(
    z.coerce.number().pipe(z.union([z.literal(7), z.literal(8), z.literal(9)])),
  ),
  year: param(z.string().refine(isAcademicYear)),
  status: param(z.enum(MATERIAL_STATUSES)),
  q: param(
    z
      .string()
      .transform((value) => value.trim().slice(0, MAX_SEARCH_LENGTH).trim())
      .pipe(z.string().min(1)),
  ),
  page: z.preprocess(first, z.coerce.number().int().min(1).catch(1)),
});

export type MaterialQuery = z.infer<typeof materialQuerySchema>;

/** A folder name as stored: trimmed, 1 to MAX_FOLDER_NAME characters. */
export const folderNameSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1).max(MAX_FOLDER_NAME));

/**
 * Why a folder change was refused: `name` (empty or too long), `notFound` (not the teacher's, or in
 * the trash), `parent` (the target folder is not the teacher's or is in the trash), `nesting` (only
 * one level of subfolders: the target is itself a subfolder, or the folder has subfolders), `retry`
 * (two changes crossed; trying again works), `trashedSubfolders` (only subfolders in the trash
 * keep the folder from moving: restore them or delete them for good first).
 */
export type FolderError =
  "name" | "notFound" | "parent" | "nesting" | "retry" | "trashedSubfolders";
export type MoveMaterialError = "notFound" | "folder";
