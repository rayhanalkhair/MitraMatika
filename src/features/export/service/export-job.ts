// The export job (`render_export`, decision 11): the approved assessment as six documents (paper,
// key and solutions, each PDF and Word) plus a ZIP of all six, stored for 7 days.
//
// Gate: the approval is checked with verifyApproval (Ruling R11/R12: the hash is recomputed from
// the actual rows, the stored status is never trusted alone) inside one REPEATABLE READ
// transaction that also reads the pinned versions and the template, so every document is built
// from exactly the snapshot the gate passed (the hash covers the template's printed fields,
// Ruling R26). The logo's bytes are read after that transaction and must have the content hash
// the snapshot records. Rendering runs after that transaction (it holds no locks while React-PDF
// prints); the rows are written in a second transaction that checks the gate again, so an assessment that
// was reopened or changed meanwhile gets no export.
//
// All or nothing: any failure deletes what this attempt stored, and the rows are written only
// once all seven files are stored. Idempotent per job: the object keys and the row ids derive from
// the job id, and a run that finds the job's rows already written does nothing.
//
// Writes go through the service connection with explicit owner filters (Ruling R1): the teacher
// can only read `exports` and `question_usages`.
import "server-only";
import { createHash } from "node:crypto";
import { and, count, eq, sql } from "drizzle-orm";
import JSZip from "jszip";
import { z } from "zod";
import { verifyApproval, type AssessmentDb } from "@/features/assessments";
import {
  getTemplate,
  logoSha256,
  readLogo,
  type TemplateView,
} from "@/features/templates";
import { safeErrorSummary } from "@/lib/db/error-summary";
import { exports, questionUsages } from "@/lib/db/schema";
import {
  PermanentJobError,
  RetryableJobError,
  type HandlerResult,
  type JobHandler,
} from "@/lib/jobs/handler";
import type { Progress } from "@/lib/jobs/types";
import { logger } from "@/lib/logger";
import { assertAppStorageRoom } from "@/lib/storage/app-total";
import type { ObjectStore } from "@/lib/storage/types";
import {
  buildDocumentModel,
  type ExportDocument,
  type ExportSnapshot,
} from "./document-model";
import {
  CONTENT_TYPES,
  downloadName,
  EXPORT_FILES,
  exportObjectKey,
  exportPrefix,
  type ExportFile,
} from "./file-names";
import { loadVersions } from "./load-snapshot";
import { createMathCache, type MathCache } from "./pdf/math-box";
import { oneAtATime } from "./render-queue";
import { renderDocxDocument, RenderDocxError, type DocxWarning } from "./render-docx";
import type { DocumentKind } from "./render-html";
import {
  PDF_TIMEOUT_MS,
  renderPdf,
  RenderPdfError,
  type RenderPdfResult,
} from "./render-pdf";
import type { RenderWarning } from "./rich-text";
import type { LogoOmittedWarning } from "./warnings";

export const EXPORT_JOB_TYPE = "render_export";
/** How long the files of an export can be downloaded. */
export const EXPORT_TTL_MS = 7 * 86_400_000;
/** A PDF longer than this is refused as too large. */
export const MAX_PDF_PAGES = 100;
/** Any one stored file larger than this is refused. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** All rendering of one export must finish within this (the runner's own budget is 240 s). */
export const EXPORT_BUDGET_MS = 180_000;
/** An export does not start with less than this left of the runner's budget; it waits instead. */
export const MIN_START_MS = 120_000;
// Kept free at the end of the runner's budget for the write transaction and the cleanup.
const SAFETY_MS = 20_000;
const WAIT_MS = 30_000;

const KINDS: readonly DocumentKind[] = ["paper", "key", "solutions"];

export const exportPayloadSchema = z.object({
  assessmentId: z.uuid(),
  snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
});

export interface ExportJobDeps {
  db: AssessmentDb;
  store: ObjectStore;
  renderPdf?: (
    doc: ExportDocument,
    kind: DocumentKind,
    options: { timeoutMs: number; math: MathCache },
  ) => Promise<RenderPdfResult>;
  now?: () => Date;
}

/** The failure codes the export panel translates (job error.code). */
export type ExportFailureCode =
  | "export_invalid"
  | "export_not_found"
  | "export_not_approved"
  | "export_stale"
  | "export_too_large"
  | "export_renderer_unavailable" // old job rows only: nothing emits it any more
  | "export_render_failed"
  | "app_storage_full"
  | "export_failed";

const MESSAGES: Record<ExportFailureCode, string> = {
  export_invalid: "The export job payload is not valid.",
  export_not_found: "The assessment of the export was not found.",
  export_not_approved: "The assessment is not approved.",
  export_stale: "The assessment changed after the export was requested.",
  export_too_large: "The export is too large to render.",
  export_renderer_unavailable: "The PDF renderer is not available.",
  export_render_failed: "A document could not be rendered.",
  app_storage_full: "Penyimpanan MitraMatika penuh.",
  export_failed: "The export could not be completed.",
};

const permanent = (code: ExportFailureCode) =>
  new PermanentJobError(code, MESSAGES[code]);

/**
 * The id of an export row: a uuid (version nibble 8, RFC variant) derived from the job id and the
 * file, so a retried job writes the same rows (insert ... on conflict do nothing).
 */
export function exportRowId(jobId: string, file: ExportFile): string {
  const hex = createHash("sha256")
    .update(`export:${jobId.toLowerCase()}:${file.document}:${file.format}`)
    .digest("hex");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

interface Loaded {
  snapshot: ExportSnapshot;
  template: TemplateView | null;
}

async function exportWritten(
  db: AssessmentDb,
  input: { ownerId: string; jobId: string },
): Promise<boolean> {
  const row = (
    await db
      .select({ n: count() })
      .from(exports)
      .where(and(eq(exports.ownerId, input.ownerId), eq(exports.jobId, input.jobId)))
  ).at(0);
  return (row?.n ?? 0) > 0;
}

function gateFailure(failure: "notFound" | "notApproved" | "stale"): PermanentJobError {
  if (failure === "notFound") return permanent("export_not_found");
  if (failure === "notApproved") return permanent("export_not_approved");
  return permanent("export_stale");
}

/** The approved snapshot, its versions' content and its template, read as one snapshot. */
async function loadApproved(
  db: AssessmentDb,
  input: { ownerId: string; assessmentId: string; snapshotHash: string },
): Promise<Loaded> {
  const { ownerId, assessmentId } = input;
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as AssessmentDb;
    // Every read below sees the same committed state (no edit can slip in between them).
    await tx.execute(sql`set transaction isolation level repeatable read, read only`);
    const gate = await verifyApproval(tx, { ownerId, assessmentId });
    if (!gate.ok) throw gateFailure(gate.error);
    if (gate.data.hash !== input.snapshotHash) throw permanent("export_stale");
    const { snapshot } = gate.data;
    const content = await loadVersions(tx, { ownerId, snapshot });
    if (!content.ok) throw permanent("export_stale");
    let template: TemplateView | null = null;
    if (snapshot.template) {
      // Read in the same snapshot as the gate, which covered its printed fields (R26) and refused
      // a trashed one: not found here means it changed under us all the same.
      const found = await getTemplate(tx, { ownerId, templateId: snapshot.template.id });
      if (!found.ok) throw permanent("export_stale");
      template = found.data;
    }
    return { snapshot: content.data, template };
  });
}

/** The template names a logo, but its file could not be read: the documents have none. */
export interface LogoMissingWarning {
  code: "logoMissing";
  where: { part: "letterhead" };
}

/** What a stored file's row records for the teacher to check. */
export type ExportWarning =
  RenderWarning | DocxWarning | LogoOmittedWarning | LogoMissingWarning;

const LOGO_MISSING: LogoMissingWarning = {
  code: "logoMissing",
  where: { part: "letterhead" },
};

interface StoredFile extends ExportFile {
  key: string;
  /** The real byte length of the stored object (exports.size_bytes, ADR-0022). */
  sizeBytes: number;
  warnings: ExportWarning[];
}

function mapError(error: unknown): Error {
  if (error instanceof PermanentJobError || error instanceof RetryableJobError)
    return error;
  if (error instanceof RenderPdfError) {
    // A document over the caps or past the time limit is too large; anything else failed to print.
    if (error.code === "tooLarge" || error.code === "timeout") {
      return permanent("export_too_large");
    }
    return permanent("export_render_failed");
  }
  if (error instanceof RenderDocxError) return permanent("export_render_failed");
  // Storage or database: retried by the runner. The message is a fixed sentence (it is stored).
  return new RetryableJobError("export_failed", MESSAGES.export_failed);
}

function waitResult(now: Date, progress: Progress): HandlerResult {
  return { kind: "defer", runAfter: new Date(now.getTime() + WAIT_MS), progress };
}

export function createRenderExportHandler(deps: ExportJobDeps): JobHandler {
  const clock = deps.now ?? (() => new Date());
  const print =
    deps.renderPdf ??
    ((
      doc: ExportDocument,
      kind: DocumentKind,
      options: { timeoutMs: number; math: MathCache },
    ) => renderPdf(doc, kind, options));
  const { db, store } = deps;

  return async (ctx) => {
    const parsed = exportPayloadSchema.safeParse(ctx.job.payload);
    if (!parsed.success) throw permanent("export_invalid");
    const { assessmentId, snapshotHash } = parsed.data;
    const ownerId = ctx.ownerId;
    const jobId = ctx.job.id;
    const done: HandlerResult = {
      kind: "done",
      progress: { step: "done", done: EXPORT_FILES.length, total: EXPORT_FILES.length },
    };

    // A run after the commit (a lost lease, a crash before the job was marked done).
    if (await exportWritten(db, { ownerId, jobId })) return done;

    const start = clock();
    const remaining = ctx.deadline - Date.now();
    if (remaining < MIN_START_MS) {
      return waitResult(start, { step: "queued", done: 0, total: EXPORT_FILES.length });
    }
    const renderDeadline = Date.now() + Math.min(EXPORT_BUDGET_MS, remaining - SAFETY_MS);
    const timeLeft = () => renderDeadline - Date.now();

    const prefix = exportPrefix(ownerId, jobId);
    try {
      const loaded = await loadApproved(db, { ownerId, assessmentId, snapshotHash });
      // The logo is read after the transaction (readLogo checks the key belongs to the template,
      // R13). Its bytes must be the approved ones: a same-format upload overwrites the object
      // before its row commits, and only the content hash tells them apart (R26). A changed row
      // is caught by the write gate below.
      let logo: { bytes: Uint8Array; contentType: string } | null = null;
      let logoMissing = false;
      if (loaded.template?.hasLogo) {
        const read = await readLogo(store, db, {
          ownerId,
          templateId: loaded.template.id,
        });
        if (read.ok) {
          const approvedSha = loaded.snapshot.template?.printed.logo?.sha256 ?? null;
          if (approvedSha !== null && logoSha256(read.data.bytes) !== approvedSha) {
            throw permanent("export_stale");
          }
          logo = read.data;
        } else logoMissing = true;
      }
      const doc = buildDocumentModel(loaded.snapshot, loaded.template, { logo });

      // One cache for the three PDFs: the paper and the solutions share formulas.
      const math = createMathCache();
      const stored: StoredFile[] = [];
      let storedBytes = 0;
      const zipEntries: { name: string; bytes: Uint8Array }[] = [];
      const save = async (
        file: ExportFile,
        bytes: Uint8Array,
        warnings: StoredFile["warnings"],
      ) => {
        if (bytes.byteLength > MAX_FILE_BYTES) throw permanent("export_too_large");
        // The app-wide cap (ADR-0022), without the lock: this attempt's earlier files are not in
        // the database yet, so they are added to the file at hand. Nothing is stored when full.
        const room = await assertAppStorageRoom(
          db,
          storedBytes + bytes.byteLength,
          "export",
        );
        if (!room.ok) throw permanent("app_storage_full");
        const key = exportObjectKey(ownerId, jobId, file);
        await store.put(key, bytes, CONTENT_TYPES[file.format]);
        storedBytes += bytes.byteLength;
        stored.push({
          ...file,
          key,
          sizeBytes: bytes.byteLength,
          warnings:
            logoMissing && file.document !== "zip"
              ? [...warnings, LOGO_MISSING]
              : warnings,
        });
        if (file.document !== "zip") {
          zipEntries.push({ name: downloadName(loaded.snapshot.title, file), bytes });
        }
      };

      for (const kind of KINDS) {
        const pdf = await oneAtATime(() => {
          const budget = timeLeft();
          if (budget <= 0) throw permanent("export_too_large");
          return print(doc, kind, {
            timeoutMs: Math.min(PDF_TIMEOUT_MS, budget),
            math,
          });
        });
        // The renderer's own page count (cross-checked there with the file). A printed document
        // has at least one page: anything else cannot be trusted, so the cap fails safe.
        if (pdf.pages < 1) throw permanent("export_render_failed");
        if (pdf.pages > MAX_PDF_PAGES) throw permanent("export_too_large");
        await save({ document: kind, format: "pdf" }, pdf.bytes, pdf.warnings);

        const docx = await renderDocxDocument(doc, kind, doc.page);
        if (timeLeft() <= 0) throw permanent("export_too_large");
        await save({ document: kind, format: "docx" }, docx.bytes, docx.warnings);
      }

      const zip = new JSZip();
      for (const entry of zipEntries) zip.file(entry.name, entry.bytes);
      const bundle = await zip.generateAsync({
        type: "uint8array",
        compression: "DEFLATE",
      });
      await save({ document: "zip", format: "zip" }, bundle, []);

      await commitExport(db, {
        ownerId,
        assessmentId,
        jobId,
        snapshotHash,
        snapshot: loaded.snapshot,
        files: stored,
        now: clock(),
      });
      return done;
    } catch (error) {
      await removePartial(db, store, { ownerId, jobId, prefix });
      const mapped = mapError(error);
      if (mapped instanceof RetryableJobError) {
        logger.error(
          { module: "export", jobId, err: safeErrorSummary(error) },
          "export: the export failed and will be retried",
        );
      }
      throw mapped;
    }
  };
}

/** Deletes this attempt's objects, unless the rows were committed after all (then they stay). */
async function removePartial(
  db: AssessmentDb,
  store: ObjectStore,
  input: { ownerId: string; jobId: string; prefix: string },
): Promise<void> {
  try {
    if (await exportWritten(db, input)) return;
    await store.deletePrefix(input.prefix);
  } catch (error) {
    // Left behind: a retried attempt (same keys) overwrites or removes them, and anything else
    // (a permanent failure, a killed function) goes with the bucket's 8-day lifecycle rule on
    // exports/ (runbook, R2 app bucket).
    logger.error(
      { module: "export", jobId: input.jobId, err: safeErrorSummary(error) },
      "export: could not remove the files of a failed export",
    );
  }
}

/**
 * Writes the seven rows and the usage of every pinned version (once per export: the usage names
 * the ZIP row, and the unique constraint plus `on conflict do nothing` keep a retry from counting
 * twice). Serialised per job; the gate is checked again so a reopened or changed assessment gets
 * no export.
 */
async function commitExport(
  db: AssessmentDb,
  input: {
    ownerId: string;
    assessmentId: string;
    jobId: string;
    snapshotHash: string;
    snapshot: ExportSnapshot;
    files: StoredFile[];
    now: Date;
  },
): Promise<void> {
  const { ownerId, assessmentId, jobId, now } = input;
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as AssessmentDb;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`render_export:${jobId}`}, 0))`,
    );
    if (await exportWritten(tx, { ownerId, jobId })) return;
    const gate = await verifyApproval(tx, { ownerId, assessmentId });
    if (!gate.ok) throw gateFailure(gate.error);
    if (gate.data.hash !== input.snapshotHash) throw permanent("export_stale");

    const expiresAt = new Date(now.getTime() + EXPORT_TTL_MS);
    await tx
      .insert(exports)
      .values(
        input.files.map((file) => ({
          id: exportRowId(jobId, file),
          ownerId,
          assessmentId,
          document: file.document,
          format: file.format,
          objectKey: file.key,
          sizeBytes: file.sizeBytes,
          snapshotHash: input.snapshotHash,
          warnings: file.warnings,
          expiresAt,
          jobId,
          createdAt: now,
        })),
      )
      .onConflictDoNothing();

    const exportId = exportRowId(jobId, { document: "zip", format: "zip" });
    const items = input.snapshot.sections.flatMap((section) => section.items);
    const seen = new Set<string>();
    const usages = items.flatMap((item) => {
      if (seen.has(item.versionId)) return [];
      seen.add(item.versionId);
      return [
        {
          ownerId,
          questionId: item.questionId,
          questionVersionId: item.versionId,
          assessmentId,
          exportId,
          usedAt: now,
        },
      ];
    });
    if (usages.length > 0) {
      await tx.insert(questionUsages).values(usages).onConflictDoNothing();
    }
  });
}
