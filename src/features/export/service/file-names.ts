import { assertSafeKey } from "@/lib/storage/types";

// What one export consists of and how its files are named: in storage by ids only, for the teacher
// by the assessment title (the only personal text a download name carries).

export type ExportFileDocument = "paper" | "key" | "solutions" | "zip";
export type ExportFileFormat = "pdf" | "docx" | "zip";

export interface ExportFile {
  document: ExportFileDocument;
  format: ExportFileFormat;
}

/** The six documents, then the ZIP that bundles them (the order the panel lists them in). */
export const EXPORT_FILES: readonly ExportFile[] = [
  { document: "paper", format: "pdf" },
  { document: "paper", format: "docx" },
  { document: "key", format: "pdf" },
  { document: "key", format: "docx" },
  { document: "solutions", format: "pdf" },
  { document: "solutions", format: "docx" },
  { document: "zip", format: "zip" },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every object of one export sits under `exports/<ownerId>/<jobId>/`: ids only. */
export function exportPrefix(ownerId: string, jobId: string): string {
  if (!UUID.test(ownerId) || !UUID.test(jobId)) {
    throw new Error("export: the storage prefix needs an owner id and a job id");
  }
  return `exports/${ownerId.toLowerCase()}/${jobId.toLowerCase()}/`;
}

export function exportObjectKey(
  ownerId: string,
  jobId: string,
  file: ExportFile,
): string {
  const name = file.document === "zip" ? "bundle.zip" : `${file.document}.${file.format}`;
  return `${exportPrefix(ownerId, jobId)}${name}`;
}

const SUFFIX: Record<Exclude<ExportFileDocument, "zip">, string> = {
  paper: "naskah-soal",
  key: "kunci-jawaban",
  solutions: "pembahasan",
};

const MAX_BASE = 60;

/**
 * The assessment title as a file name stem: accents dropped, lower case, every run of anything
 * but a-z and 0-9 turned into one minus sign, at most 60 characters; "asesmen" when nothing is left.
 */
export function titleStem(title: string): string {
  const stem = title
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_BASE)
    .replace(/-+$/g, "");
  return stem === "" ? "asesmen" : stem;
}

/** "ulangan-bab-1-naskah-soal.pdf", "ulangan-bab-1.zip" (always passes assertSafeDownloadName). */
export function downloadName(title: string, file: ExportFile): string {
  const stem = titleStem(title);
  if (file.document === "zip") return `${stem}.zip`;
  return `${stem}-${SUFFIX[file.document]}.${file.format}`;
}

export const CONTENT_TYPES: Record<ExportFileFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  zip: "application/zip",
};

/** Whether a stored export key is a safe key under `exports/<ownerId>/`. */
export function isOwnExportKey(ownerId: string, key: string): boolean {
  if (!key.startsWith(`exports/${ownerId.toLowerCase()}/`)) return false;
  try {
    assertSafeKey(key);
    return true;
  } catch {
    return false;
  }
}
