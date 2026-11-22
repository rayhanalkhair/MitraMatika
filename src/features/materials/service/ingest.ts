// The ingestion job (`ingest_material`, decision 4): the text of every page of a finalised material,
// with a quality rating per page. Nothing is sent to a model and nothing is OCR'd: a page that is
// not `high` only gets `ocr_status = available` (PDF pages and images; a Word page has no picture
// to read), and the teacher decides.
//
// - PDF: steps of INGEST_STEP_PAGES pages; each step reads its pages in the bounded worker
//   (Rulings R10/R12), writes them and returns `continue` with the next page in the job's progress,
//   so a 300-page book fits the runner's 240 s budget across runs. At most MAX_PDF_PAGES pages are
//   read whatever the file or finalise said (Ruling R9).
// - DOCX: one step, read in the bounded DOCX worker (docx-text.ts, Ruling R15: mammoth + OMML to
//   LaTeX, its own page model). A document longer than MAX_PDF_PAGES pages keeps its first pages
//   and the last kept page is flagged `truncated` (at most medium), so the material needs review.
// - Before parsing, the function must be able to load the parsing packages (dependencies.ts,
//   R15); otherwise the job waits for another function and the material is not touched.
// - Image: one page with no text, waiting for OCR.
//
// Idempotent: pages are inserted with ON CONFLICT (material_id, page_no) DO NOTHING, so a step run
// again after a crash or a lost checkpoint writes no page twice (and never overwrites a page that
// was corrected meanwhile). A step starts only with MIN_STEP_MS of the runner's budget left;
// otherwise the job waits for the next run without doing anything.
//
// Gate: the material must belong to the job's owner (else the job is refused and nothing is
// touched), must not be in the trash (a trashed one is a no-op) and must still be `uploaded` or
// `processing`. Before parsing, the stored bytes must hash to the sha-256 that finalise recorded
// (Ruling R11). Status: uploaded -> processing -> ready (every page high) | needs_review | failed.
// Writes go through the service connection with explicit owner filters (bank R9): the teacher can
// only read pages. Logs carry codes and error names, never file content.
import "server-only";
import { createHash } from "node:crypto";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { safeErrorSummary } from "@/lib/db/error-summary";
import { materialPages, materials } from "@/lib/db/schema";
import {
  PermanentJobError,
  RetryableJobError,
  type HandlerResult,
  type JobHandler,
} from "@/lib/jobs/handler";
import type { Progress } from "@/lib/jobs/types";
import { logger } from "@/lib/logger";
import type { ObjectStore } from "@/lib/storage/types";
import { MAX_PDF_PAGES, type MaterialKind } from "../schema/upload";
import { ingestDependenciesAvailable } from "./dependencies";
import { extractDocxPages } from "./docx-text";
import { pageQuality, type PageFlag } from "./page-quality";
import { extractPdfText } from "./pdf-text";
import { isOwnMaterialKey, type MaterialDb } from "./upload";

export const INGEST_STEP_PAGES = 25;
/**
 * A step needs this much of the runner's budget: download and hash (up to 25 MB), the worker's
 * hard timeout (20 s) and the writes.
 */
export const MIN_STEP_MS = 45_000;
/** How long a job waits when this function cannot load the parsing packages (Ruling R15). */
export const DEPENDENCY_WAIT_MS = 60_000;
/**
 * Claims by functions without the packages before the job gives up. The route functions (the
 * status poll, the finalise route, the daily run) carry them, so a job normally waits until the
 * next of those; this only ends a misconfiguration.
 */
export const MAX_DEPENDENCY_DEFERRALS = 100;

/** The failure codes of the job (job error.code); the material's status becomes `failed`. */
export type IngestFailureCode =
  | "ingest_invalid"
  | "ingest_not_found"
  | "ingest_missing"
  | "ingest_corrupt"
  | "ingest_damaged"
  | "ingest_too_large"
  | "ingest_unavailable"
  | "ingest_failed";

const MESSAGES: Record<IngestFailureCode, string> = {
  ingest_invalid: "The ingestion job payload is not valid.",
  ingest_not_found: "The material of the ingestion job was not found.",
  ingest_missing: "The material's file is missing.",
  ingest_corrupt: "The material's file is not the one that was uploaded.",
  ingest_damaged: "The material's file could not be read.",
  ingest_too_large: "The material's document is too large to read.",
  ingest_unavailable:
    "The server could not load the packages needed to read the material.",
  ingest_failed: "The material could not be read; it will be retried.",
};

const permanent = (code: IngestFailureCode) =>
  new PermanentJobError(code, MESSAGES[code]);

const payloadSchema = z.object({ materialId: z.uuid() });

export interface IngestDeps {
  db: MaterialDb;
  store: ObjectStore;
  now?: () => Date;
  extractPdfText?: typeof extractPdfText;
  extractDocxPages?: typeof extractDocxPages;
  dependenciesAvailable?: typeof ingestDependenciesAvailable;
}

type Material = Pick<
  typeof materials.$inferSelect,
  | "id"
  | "ownerId"
  | "kind"
  | "sha256"
  | "objectKey"
  | "status"
  | "pageCount"
  | "deletedAt"
>;

interface PageText {
  pageNo: number;
  text: string;
  /** The document went on past this page and the rest was not kept (DOCX, Ruling R15). */
  truncated?: boolean;
}

const SKIPPED: HandlerResult = {
  kind: "done",
  progress: { step: "skipped", done: 0, total: 0 },
};
const doneResult = (total: number): HandlerResult => ({
  kind: "done",
  progress: { step: "done", done: total, total },
});

/** The page the next PDF step starts at (1 when there is no usable checkpoint). */
function nextPageOf(progress: Progress | null): number {
  const next = progress?.nextPage;
  return typeof next === "number" && Number.isSafeInteger(next) && next >= 1 ? next : 1;
}

/** Another parse held the process's slot: the same step runs again a little later. */
const BUSY_RETRY_MS = 30_000;
function busyAgain(progress: Progress | null): HandlerResult {
  return {
    kind: "defer",
    runAfter: new Date(Date.now() + BUSY_RETRY_MS),
    ...(progress ? { progress } : {}),
  };
}

export function createIngestMaterialHandler(deps: IngestDeps): JobHandler {
  const { db, store } = deps;
  const clock = deps.now ?? (() => new Date());
  const readPdf = deps.extractPdfText ?? extractPdfText;
  const readDocx = deps.extractDocxPages ?? extractDocxPages;
  const available = deps.dependenciesAvailable ?? ingestDependenciesAvailable;

  const own = (material: Material) =>
    and(eq(materials.id, material.id), eq(materials.ownerId, material.ownerId));

  async function markFailed(material: Material): Promise<void> {
    await db
      .update(materials)
      .set({ status: "failed", updatedAt: clock() })
      .where(and(own(material), inArray(materials.status, ["uploaded", "processing"])));
  }

  /** Marks the material failed, then gives the error to throw. */
  async function fail(material: Material, code: IngestFailureCode) {
    await markFailed(material);
    return permanent(code);
  }

  async function insertPages(
    material: Material,
    pages: PageText[],
    source: "pdf_text" | "docx" | null,
  ): Promise<void> {
    if (pages.length === 0) return;
    const now = clock();
    // OCR needs a picture of the page: PDF pages (rendered by the browser) and images.
    const ocrPossible = material.kind !== "docx";
    await db
      .insert(materialPages)
      .values(
        pages.map(({ pageNo, text, truncated }) => {
          const quality = pageQuality(text);
          // A cut-off document is never "ready": its last page says so and asks for review.
          const flags: PageFlag[] = truncated
            ? [...quality.flags, "truncated"]
            : quality.flags;
          const confidence =
            truncated && quality.confidence === "high" ? "medium" : quality.confidence;
          return {
            ownerId: material.ownerId,
            materialId: material.id,
            pageNo,
            textMd: text,
            textSource: text === "" ? null : source,
            confidence,
            flags,
            ocrStatus: ocrPossible && confidence !== "high" ? "available" : "none",
            createdAt: now,
            updatedAt: now,
          };
        }),
      )
      .onConflictDoNothing({ target: [materialPages.materialId, materialPages.pageNo] });
  }

  /** Counts the stored pages and sets the final status (ready only when every page is high). */
  async function finish(material: Material): Promise<HandlerResult> {
    const [stats] = await db
      .select({
        pages: count(),
        unsure: count(sql`case when ${materialPages.confidence} <> 'high' then 1 end`),
      })
      .from(materialPages)
      .where(
        and(
          eq(materialPages.materialId, material.id),
          eq(materialPages.ownerId, material.ownerId),
        ),
      );
    if (stats.pages === 0) throw await fail(material, "ingest_damaged");
    await db
      .update(materials)
      .set({
        status: stats.unsure > 0 ? "needs_review" : "ready",
        pageCount: stats.pages,
        updatedAt: clock(),
      })
      .where(
        and(
          own(material),
          eq(materials.status, "processing"),
          isNull(materials.deletedAt),
        ),
      );
    return doneResult(stats.pages);
  }

  /** The stored file, after checking it is the owner's and the one finalise hashed (R11). */
  async function readFile(material: Material): Promise<Uint8Array> {
    if (!isOwnMaterialKey(material.ownerId, material.objectKey)) {
      throw await fail(material, "ingest_corrupt");
    }
    const bytes = await store.get(material.objectKey);
    if (!bytes) throw await fail(material, "ingest_missing");
    if (createHash("sha256").update(bytes).digest("hex") !== material.sha256) {
      throw await fail(material, "ingest_corrupt");
    }
    return bytes;
  }

  async function pdfStep(
    material: Material,
    bytes: Uint8Array,
    progress: Progress | null,
    waitMs: number,
  ): Promise<HandlerResult> {
    const from = nextPageOf(progress);
    if (from > MAX_PDF_PAGES) return finish(material);
    const to = Math.min(from + INGEST_STEP_PAGES - 1, MAX_PDF_PAGES);
    const result = await readPdf(bytes, { from, to, waitMs, ownerId: material.ownerId });
    // Another parse held the process's slot (R29): try this step again shortly.
    if (result.status === "busy") return busyAgain(progress);
    if (result.status !== "ok") throw await fail(material, "ingest_damaged");
    const total = Math.min(result.pages, MAX_PDF_PAGES);
    await insertPages(
      material,
      result.texts.map((text, i) => ({ pageNo: from + i, text })),
      "pdf_text",
    );
    const next = from + result.texts.length;
    if (next > total) return finish(material);
    return {
      kind: "continue",
      progress: { step: "pages", done: next - 1, total, nextPage: next },
    };
  }

  async function docxStep(
    material: Material,
    bytes: Uint8Array,
    waitMs: number,
  ): Promise<HandlerResult> {
    const result = await readDocx(bytes, { waitMs, ownerId: material.ownerId });
    if (!result.ok && result.error === "busy") return busyAgain(null);
    if (!result.ok) {
      throw await fail(
        material,
        result.error === "tooLarge" ? "ingest_too_large" : "ingest_damaged",
      );
    }
    const { pages, truncated } = result.data;
    await insertPages(
      material,
      pages.map((text, i) => ({
        pageNo: i + 1,
        text,
        truncated: truncated && i === pages.length - 1,
      })),
      "docx",
    );
    return finish(material);
  }

  return async (ctx) => {
    const parsed = payloadSchema.safeParse(ctx.job.payload);
    if (!parsed.success) throw permanent("ingest_invalid");

    const material = (
      await db
        .select({
          id: materials.id,
          ownerId: materials.ownerId,
          kind: materials.kind,
          sha256: materials.sha256,
          objectKey: materials.objectKey,
          status: materials.status,
          pageCount: materials.pageCount,
          deletedAt: materials.deletedAt,
        })
        .from(materials)
        .where(
          and(
            eq(materials.id, parsed.data.materialId),
            eq(materials.ownerId, ctx.ownerId),
          ),
        )
    ).at(0);
    // Absent, or another owner's: the job's owner does not own it, so nothing is touched.
    if (!material) throw permanent("ingest_not_found");
    if (material.deletedAt) return SKIPPED;
    // Already ingested (or failed): nothing to do, and nothing is reported as done again.
    if (material.status !== "uploaded" && material.status !== "processing")
      return SKIPPED;

    // Not enough of the runner's budget left for a step: wait until this run is over.
    if (ctx.deadline - Date.now() < MIN_STEP_MS) {
      return {
        kind: "defer",
        runAfter: new Date(ctx.deadline),
        progress: ctx.progress ?? {
          step: "pages",
          done: 0,
          total: material.pageCount ?? 0,
          nextPage: 1,
        },
      };
    }

    // This function cannot load the parsing packages: wait for one that can (never "damaged").
    // The probe takes the parse slot only when it is free (never waits in the queue).
    const probe = await available(material.kind as MaterialKind, material.ownerId);
    if (probe === "busy") return busyAgain(ctx.progress);
    if (!probe) {
      const previous = Number(ctx.progress?.dependencyDeferrals ?? 0);
      const deferrals = Number.isSafeInteger(previous) && previous > 0 ? previous + 1 : 1;
      if (deferrals > MAX_DEPENDENCY_DEFERRALS)
        throw await fail(material, "ingest_unavailable");
      return {
        kind: "defer",
        runAfter: new Date(Date.now() + DEPENDENCY_WAIT_MS),
        progress: {
          ...(ctx.progress ?? { step: "pages", done: 0, total: material.pageCount ?? 0 }),
          dependencyDeferrals: deferrals,
        },
      };
    }

    // A cold probe takes time of its own: the step starts only if its budget is still there.
    if (ctx.deadline - Date.now() < MIN_STEP_MS) {
      return {
        kind: "defer",
        runAfter: new Date(ctx.deadline),
        ...(ctx.progress ? { progress: ctx.progress } : {}),
      };
    }

    try {
      await db
        .update(materials)
        .set({ status: "processing", updatedAt: clock() })
        .where(
          and(
            own(material),
            inArray(materials.status, ["uploaded", "processing"]),
            isNull(materials.deletedAt),
          ),
        );
      const bytes = await readFile(material);
      // The parse slot (R29) may be awaited only as long as a step still fits after it.
      const waitMs = Math.max(0, ctx.deadline - Date.now() - MIN_STEP_MS);
      if (material.kind === "pdf") {
        return await pdfStep(material, bytes, ctx.progress, waitMs);
      }
      if (material.kind === "docx") return await docxStep(material, bytes, waitMs);
      if (material.kind === "image") {
        await insertPages(material, [{ pageNo: 1, text: "" }], null);
        return await finish(material);
      }
      throw await fail(material, "ingest_damaged");
    } catch (error) {
      if (error instanceof PermanentJobError) throw error;
      // Storage or database: retried by the runner. On the last attempt the material is failed.
      const lastAttempt = ctx.job.attempts + 1 >= ctx.job.maxAttempts;
      logger.error(
        {
          module: "materials",
          jobId: ctx.job.id,
          lastAttempt,
          err: safeErrorSummary(error),
        },
        "materials: ingestion step failed",
      );
      if (lastAttempt) {
        try {
          await markFailed(material);
        } catch {
          // The material stays `processing`; the job itself is failed by the runner.
        }
      }
      throw new RetryableJobError("ingest_failed", MESSAGES.ingest_failed);
    }
  };
}
