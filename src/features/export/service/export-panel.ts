// What the export panel of the builder shows: the latest export job of the assessment and the files
// of the newest export that was written, both of the CURRENT approval only (Ruling R27): a job or
// an export row of another snapshot hash (an earlier approval, before a reopen and a change) is
// never offered, so a paper that no longer matches the approved assessment cannot be downloaded
// from here. The caller applies runAsUser (the teacher may read their own jobs and exports); every
// statement also names the owner.
import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { AssessmentDb } from "@/features/assessments";
import { exports, jobs } from "@/lib/db/schema";
import type { JobStatusValue } from "@/lib/jobs/status";
import {
  EXPORT_FILES,
  type ExportFileDocument,
  type ExportFileFormat,
} from "./file-names";
import { EXPORT_JOB_TYPE } from "./export-job";
import type { WarningWhere } from "./rich-text";

/**
 * A warning as the panel shows it: where a formula fell back to text or is too wide for the page,
 * the logo Word cannot show, or a template logo whose file was missing.
 */
export type PanelWarning =
  | { code: "mathFailed" | "mathTooWide"; where: WarningWhere }
  | { code: "logoOmitted" | "logoMissing" };

export interface ExportPanelFile {
  id: string;
  document: ExportFileDocument;
  format: ExportFileFormat;
  expiresAt: string;
  warnings: PanelWarning[];
}

export interface ExportPanelData {
  /** The newest export job of this assessment (any status), or null. */
  job: { id: string; status: JobStatusValue; errorCode: string | null } | null;
  /** The files of the newest export written, in the panel's order. */
  files: ExportPanelFile[];
  /** Every listed file is past its expiry. */
  expired: boolean;
}

const whereSchema: z.ZodType<WarningWhere> = z.union([
  z.object({ part: z.literal("option"), number: z.number(), label: z.string() }),
  z.object({ part: z.literal("step"), number: z.number(), step: z.number() }),
  z.object({ part: z.literal("sectionInstructions"), section: z.string() }),
  z.object({
    part: z.enum(["stem", "instructions"]),
    number: z.number().optional(),
  }),
]);
const warningSchema = z.union([
  z.object({ code: z.enum(["mathFailed", "mathTooWide"]), where: whereSchema }),
  z.object({ code: z.enum(["logoOmitted", "logoMissing"]) }),
]);

/** The stored warnings without their sources; anything unreadable is left out. */
function parseWarnings(value: unknown): PanelWarning[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): PanelWarning[] => {
    const parsed = warningSchema.safeParse(entry);
    if (!parsed.success) return [];
    return "where" in parsed.data
      ? [{ code: parsed.data.code, where: parsed.data.where }]
      : [{ code: parsed.data.code }];
  });
}

const errorCode = (error: unknown): string | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
};

const order = (file: { document: string; format: string }) =>
  EXPORT_FILES.findIndex((f) => f.document === file.document && f.format === file.format);

export async function getExportPanel(
  db: AssessmentDb,
  input: {
    ownerId: string;
    assessmentId: string;
    /** The hash of the current approval (verifyApproval / getApprovalState when not stale). */
    snapshotHash: string;
    now: Date;
  },
): Promise<ExportPanelData> {
  const { ownerId, assessmentId, snapshotHash } = input;
  const job = (
    await db
      .select({ id: jobs.id, status: jobs.status, error: jobs.error })
      .from(jobs)
      .where(
        and(
          eq(jobs.ownerId, ownerId),
          eq(jobs.type, EXPORT_JOB_TYPE),
          sql`${jobs.payload}->>'assessmentId' = ${assessmentId}`,
          sql`${jobs.payload}->>'snapshotHash' = ${snapshotHash}`,
        ),
      )
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .limit(1)
  ).at(0);

  const newest = (
    await db
      .select({ jobId: exports.jobId })
      .from(exports)
      .where(
        and(
          eq(exports.ownerId, ownerId),
          eq(exports.assessmentId, assessmentId),
          eq(exports.snapshotHash, snapshotHash),
        ),
      )
      .orderBy(desc(exports.createdAt), desc(exports.id))
      .limit(1)
  ).at(0);
  const rows = newest?.jobId
    ? await db
        .select()
        .from(exports)
        .where(
          and(
            eq(exports.ownerId, ownerId),
            eq(exports.assessmentId, assessmentId),
            eq(exports.jobId, newest.jobId),
            eq(exports.snapshotHash, snapshotHash),
          ),
        )
    : [];
  const files = rows
    .filter((row) => order(row) >= 0)
    .sort((a, b) => order(a) - order(b))
    .map((row) => ({
      id: row.id,
      document: row.document as ExportFileDocument,
      format: row.format as ExportFileFormat,
      expiresAt: row.expiresAt.toISOString(),
      warnings: parseWarnings(row.warnings),
    }));
  return {
    job: job
      ? {
          id: job.id,
          status: job.status as JobStatusValue,
          errorCode: errorCode(job.error),
        }
      : null,
    files,
    expired:
      files.length > 0 &&
      files.every((file) => new Date(file.expiresAt).getTime() <= input.now.getTime()),
  };
}
