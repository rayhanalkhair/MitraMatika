// The object-store prefixes the trash deletes when an assessment, a template or a material goes for
// good. Built from ids only and checked before they reach storage: never an empty prefix, never
// another owner's. They mirror the writers' layouts (export/service/file-names.ts exportPrefix,
// templates/service/logo.ts logoKey, materials/service/upload.ts materialSourceKey,
// solver/service/keys.ts sessionPrefix); the trash may not import those features (their indexes
// carry UI that imports the trash), so the tests pin the layouts together (storage-keys.test.ts,
// material-trash.test.ts, solver-trash.test.ts).
import { assertSafeKey, assertSafePrefix } from "@/lib/storage/types";

/** The jobs-table type of an export run (export/service/export-job.ts EXPORT_JOB_TYPE). */
export const RENDER_EXPORT_JOB_TYPE = "render_export";
/** The materials' jobs (materials/schema: INGEST_MATERIAL_JOB, PROPOSE_STRUCTURE_JOB and
 * OCR_PAGES_JOB). */
export const INGEST_MATERIAL_JOB_TYPE = "ingest_material";
export const PROPOSE_STRUCTURE_JOB_TYPE = "propose_structure";
export const OCR_PAGES_JOB_TYPE = "ocr_pages";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idPrefix(root: string, ownerId: string, id: string): string {
  if (!UUID.test(ownerId) || !UUID.test(id)) {
    throw new Error(`trash: a ${root} prefix needs an owner id and an id`);
  }
  const prefix = `${root}/${ownerId.toLowerCase()}/${id.toLowerCase()}/`;
  assertSafePrefix(prefix);
  return prefix;
}

/** Every object of one export run: `exports/<ownerId>/<jobId>/`. */
export function exportRunPrefix(ownerId: string, jobId: string): string {
  return idPrefix("exports", ownerId, jobId);
}

/** Every object of one template (its logo): `templates/<ownerId>/<templateId>/`. */
export function templatePrefix(ownerId: string, templateId: string): string {
  return idPrefix("templates", ownerId, templateId);
}

/**
 * Every object of one material: `materials/<ownerId>/<materialId>/` (its source file and the page
 * images OCR renders under `pages/`, materials/service/upload.ts materialSourceKey).
 */
export function materialPrefix(ownerId: string, materialId: string): string {
  return idPrefix("materials", ownerId, materialId);
}

/**
 * Every object of one solver session: `solver/<ownerId>/<sessionId>/` (its staged upload and its
 * photo, solver/service/keys.ts sessionPrefix).
 */
export function solverSessionPrefix(ownerId: string, sessionId: string): string {
  return idPrefix("solver", ownerId, sessionId);
}

/** The solver's jobs (solver/schema/solver.ts SOLVER_JOB_TYPES). */
export const SOLVER_JOB_TYPES = [
  "extract_problem",
  "solve_problem",
  "alternative_method",
];

/** Whether a stored export key is a safe key under `exports/<ownerId>/` (never another owner's). */
export function isOwnExportKey(ownerId: string, key: string): boolean {
  if (!UUID.test(ownerId)) return false;
  if (!key.startsWith(`exports/${ownerId.toLowerCase()}/`)) return false;
  try {
    assertSafeKey(key);
    return true;
  } catch {
    return false;
  }
}
