import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import JSZip from "jszip";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exports, materials, questionUsages, schoolTemplates } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { PermanentJobError, type JobContext } from "@/lib/jobs/handler";
import { createJobQueue } from "@/lib/jobs/queue";
import { logger } from "@/lib/logger";
import { APP_STORAGE_CAP_BYTES } from "@/lib/storage/app-total";
import { TEACHER_STORAGE_CAP_BYTES } from "@/lib/storage/limits";
import type { ClaimedJob } from "@/lib/jobs/types";
import { reopen, type AssessmentDb } from "@/features/assessments";
import { clearAll } from "@/features/assessments/test-support";
import {
  asUser,
  reapprove,
  recordingStore,
  seedApprovedAssessment,
} from "../db-test-support";
import {
  createRenderExportHandler,
  EXPORT_JOB_TYPE,
  EXPORT_TTL_MS,
  exportRowId,
  MAX_PDF_PAGES,
  type ExportJobDeps,
} from "./export-job";
import { EXPORT_FILES, exportPrefix, type ExportFile } from "./file-names";
import type { ExportDocument } from "./document-model";
import * as mathBox from "./pdf/math-box";
import { countPdfPages, RenderPdfError, type RenderPdfResult } from "./render-pdf";

let database: TestDatabase;
const db = () => database.db as unknown as AssessmentDb;
const NOW = new Date("2026-11-20T03:00:00.000Z");

/** A small PDF-looking file with `pages` page objects. */
function fakePdf(pages = 1): Uint8Array {
  const body = Array.from(
    { length: pages },
    (_, i) => `${String(i + 3)} 0 obj\n<< /Type /Page >>\nendobj\n`,
  );
  return new TextEncoder().encode(
    `%PDF-1.7\n1 0 obj\n<< /Type /Pages /Count ${String(pages)} >>\nendobj\n${body.join("")}%%EOF\n`,
  );
}

/** What `renderPdf` returns, with a fake file of `pages` pages. */
function fakeResult(
  pages = 1,
  warnings: RenderPdfResult["warnings"] = [],
): RenderPdfResult {
  return { bytes: fakePdf(pages), pages, warnings };
}

async function enqueueAndClaim(payload: unknown, ownerId = USER_A): Promise<ClaimedJob> {
  const queue = createJobQueue(database.db, () => NOW);
  await queue.enqueue({ ownerId, type: EXPORT_JOB_TYPE, payload, runAfter: NOW });
  const job = await queue.claimNext();
  if (!job) throw new Error("no job claimed");
  return job;
}

const context = (job: ClaimedJob, over: Partial<JobContext> = {}): JobContext => ({
  job,
  ownerId: job.ownerId,
  progress: null,
  correlationId: job.correlationId,
  deadline: Date.now() + 240_000,
  ...over,
});

function setup(over: Partial<ExportJobDeps> = {}) {
  const store = recordingStore();
  const pdfCalls: { doc: ExportDocument; kind: string }[] = [];
  const deps: ExportJobDeps = {
    db: db(),
    store,
    renderPdf: (doc, kind) => {
      pdfCalls.push({ doc, kind });
      return Promise.resolve(fakeResult());
    },
    now: () => NOW,
    ...over,
  };
  return { store, pdfCalls, handler: createRenderExportHandler(deps) };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the handler to fail");
}

const exportRows = (jobId: string) =>
  database.db.select().from(exports).where(eq(exports.jobId, jobId));

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  await clearAll(database);
});

describe("render_export", () => {
  it(
    "stores six documents and a ZIP under the job's prefix, with rows that expire in 7 days",
    async () => {
      const seeded = await seedApprovedAssessment(database, { ownerId: USER_A });
      const job = await enqueueAndClaim({
        assessmentId: seeded.assessmentId,
        snapshotHash: seeded.hash,
      });
      const { store, pdfCalls, handler } = setup();

      const result = await handler(context(job));
      expect(result.kind).toBe("done");

      const prefix = exportPrefix(USER_A, job.id);
      expect(store.keys()).toEqual(
        [
          "bundle.zip",
          "key.docx",
          "key.pdf",
          "paper.docx",
          "paper.pdf",
          "solutions.docx",
          "solutions.pdf",
        ].map((name) => `${prefix}${name}`),
      );
      // One PDF per document, each from the document model and its own kind.
      expect(pdfCalls.map((call) => call.kind)).toEqual(["paper", "key", "solutions"]);
      expect(pdfCalls[0].doc.meta.title).toBe("Ulangan Bab 1");

      const rows = await exportRows(job.id);
      expect(rows).toHaveLength(7);
      for (const row of rows) {
        expect(row.ownerId).toBe(USER_A);
        expect(row.assessmentId).toBe(seeded.assessmentId);
        expect(row.snapshotHash).toBe(seeded.hash);
        expect(row.expiresAt.getTime()).toBe(NOW.getTime() + EXPORT_TTL_MS);
        expect(row.objectKey.startsWith(prefix)).toBe(true);
        expect(row.id).toBe(exportRowId(job.id, row as ExportFile));
        // The real byte length of every stored file, the ZIP included (ADR-0022).
        const stored = await store.get(row.objectKey);
        expect(stored).not.toBeNull();
        expect(row.sizeBytes).toBe(stored?.byteLength);
        expect(row.sizeBytes).toBeGreaterThan(0);
      }
      expect(rows.map((row) => `${row.document}.${row.format}`).sort()).toEqual(
        EXPORT_FILES.map((file) => `${file.document}.${file.format}`).sort(),
      );

      // The Word files are real packages; the ZIP holds all six documents.
      const docx = await store.get(`${prefix}paper.docx`);
      expect([...(docx ?? []).slice(0, 2)]).toEqual([0x50, 0x4b]);
      const zip = await JSZip.loadAsync((await store.get(`${prefix}bundle.zip`)) ?? []);
      expect(Object.keys(zip.files).sort()).toEqual([
        "ulangan-bab-1-kunci-jawaban.docx",
        "ulangan-bab-1-kunci-jawaban.pdf",
        "ulangan-bab-1-naskah-soal.docx",
        "ulangan-bab-1-naskah-soal.pdf",
        "ulangan-bab-1-pembahasan.docx",
        "ulangan-bab-1-pembahasan.pdf",
      ]);
      const zippedPdf = await zip
        .file("ulangan-bab-1-naskah-soal.pdf")
        ?.async("uint8array");
      expect(zippedPdf).toEqual(await store.get(`${prefix}paper.pdf`));
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "records one usage per question version for the export, and none twice on a retry",
    async () => {
      const seeded = await seedApprovedAssessment(database, {
        ownerId: USER_A,
        count: 3,
      });
      const job = await enqueueAndClaim({
        assessmentId: seeded.assessmentId,
        snapshotHash: seeded.hash,
      });
      const { store, handler, pdfCalls } = setup();
      await handler(context(job));
      // The runner may run a step again (a lost lease, a crash after the commit).
      expect((await handler(context(job))).kind).toBe("done");

      expect(await exportRows(job.id)).toHaveLength(7);
      expect(store.keys()).toHaveLength(7);
      // The second run found the export and rendered nothing.
      expect(pdfCalls).toHaveLength(3);
      const usages = await database.db
        .select()
        .from(questionUsages)
        .where(eq(questionUsages.assessmentId, seeded.assessmentId));
      expect(usages).toHaveLength(3);
      expect(usages.map((u) => u.questionId).sort()).toEqual(
        [...seeded.questionIds].sort(),
      );
      const zipId = exportRowId(job.id, { document: "zip", format: "zip" });
      expect(new Set(usages.map((u) => u.exportId))).toEqual(new Set([zipId]));
      expect(usages.every((u) => u.usedAt.getTime() === NOW.getTime())).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "removes what it stored when a render fails, then succeeds cleanly on the retry",
    async () => {
      const seeded = await seedApprovedAssessment(database, { ownerId: USER_A });
      const job = await enqueueAndClaim({
        assessmentId: seeded.assessmentId,
        snapshotHash: seeded.hash,
      });
      let calls = 0;
      const store = recordingStore();
      const failing = createRenderExportHandler({
        db: db(),
        store,
        now: () => NOW,
        renderPdf: () => {
          calls += 1;
          return calls === 2
            ? Promise.reject(new RenderPdfError("render"))
            : Promise.resolve(fakeResult());
        },
      });
      const error = await rejection(failing(context(job)));
      expect(error).toBeInstanceOf(PermanentJobError);
      expect((error as PermanentJobError).code).toBe("export_render_failed");
      expect(store.keys()).toEqual([]);
      expect(await exportRows(job.id)).toHaveLength(0);

      const retry = createRenderExportHandler({
        db: db(),
        store,
        now: () => NOW,
        renderPdf: () => Promise.resolve(fakeResult()),
      });
      expect((await retry(context(job))).kind).toBe("done");
      expect(store.keys()).toHaveLength(7);
      expect(await exportRows(job.id)).toHaveLength(7);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "fails for good as app_storage_full and stores nothing when the app has no room left",
    async () => {
      const seeded = await seedApprovedAssessment(database, { ownerId: USER_A });
      const job = await enqueueAndClaim({
        assessmentId: seeded.assessmentId,
        snapshotHash: seeded.hash,
      });
      const filler = crypto.randomUUID();
      await database.db.insert(materials).values({
        id: filler,
        ownerId: USER_B,
        title: "Buku",
        kind: "pdf",
        mime: "application/pdf",
        sizeBytes: APP_STORAGE_CAP_BYTES,
        sha256: "0".repeat(64),
        objectKey: `materials/${USER_B}/${filler}/source.pdf`,
      });
      vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      try {
        const { store, handler } = setup();
        const error = await rejection(handler(context(job)));
        expect(error).toMatchObject({
          name: "PermanentJobError",
          code: "app_storage_full",
          message: "Penyimpanan MitraMatika penuh.",
        });
        expect(store.keys()).toEqual([]);
        expect(await exportRows(job.id)).toHaveLength(0);
      } finally {
        await database.db.delete(materials).where(eq(materials.id, filler));
      }
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "fails for good as export_quota, storing nothing, when the teacher's own 300 MB is full",
    async () => {
      const seeded = await seedApprovedAssessment(database, { ownerId: USER_A });
      const job = await enqueueAndClaim({
        assessmentId: seeded.assessmentId,
        snapshotHash: seeded.hash,
      });
      // Teacher A's stored materials fill her cap (the app as a whole is nowhere near full).
      const filler = crypto.randomUUID();
      await database.db.insert(materials).values({
        id: filler,
        ownerId: USER_A,
        title: "Buku",
        kind: "pdf",
        mime: "application/pdf",
        sizeBytes: TEACHER_STORAGE_CAP_BYTES,
        sha256: "0".repeat(64),
        objectKey: `materials/${USER_A}/${filler}/source.pdf`,
      });
      try {
        const { store, handler } = setup();
        const error = await rejection(handler(context(job)));
        expect(error).toMatchObject({
          name: "PermanentJobError",
          code: "export_quota",
        });
        expect(store.keys()).toEqual([]);
        expect(await exportRows(job.id)).toHaveLength(0);
      } finally {
        await database.db.delete(materials).where(eq(materials.id, filler));
      }
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "counts the files already stored by the attempt, so the ZIP cannot push past the cap",
    async () => {
      const seeded = await seedApprovedAssessment(database, { ownerId: USER_A });
      const job = await enqueueAndClaim({
        assessmentId: seeded.assessmentId,
        snapshotHash: seeded.hash,
      });
      const { store: probe, handler: probeHandler } = setup();
      await probeHandler(context(job));
      const probed = await exportRows(job.id);
      const total = probed.reduce((sum, row) => sum + row.sizeBytes, 0);
      const bundle = probed.find((row) => row.document === "zip")?.sizeBytes ?? 0;
      expect(bundle).toBeGreaterThan(1000);
      await database.db.delete(exports).where(eq(exports.jobId, job.id));
      expect(probe.keys()).toHaveLength(7);

      // Room for every file but half of the ZIP: robust to small size differences between renders.
      const second = await enqueueAndClaim({
        assessmentId: seeded.assessmentId,
        snapshotHash: seeded.hash,
      });
      const filler = crypto.randomUUID();
      await database.db.insert(materials).values({
        id: filler,
        ownerId: USER_B,
        title: "Buku",
        kind: "pdf",
        mime: "application/pdf",
        sizeBytes: APP_STORAGE_CAP_BYTES - total + Math.floor(bundle / 2),
        sha256: "0".repeat(64),
        objectKey: `materials/${USER_B}/${filler}/source.pdf`,
      });
      vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      try {
        const { store, handler } = setup();
        const error = await rejection(handler(context(second)));
        expect(error).toMatchObject({ code: "app_storage_full" });
        expect(store.keys()).toEqual([]);
      } finally {
        await database.db.delete(materials).where(eq(materials.id, filler));
      }
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses when the snapshot changed since the export was asked for",
    async () => {
      const seeded = await seedApprovedAssessment(database, { ownerId: USER_A });
      const job = await enqueueAndClaim({
        assessmentId: seeded.assessmentId,
        snapshotHash: "0".repeat(64),
      });
      const { store, handler, pdfCalls } = setup();
      const error = await rejection(handler(context(job)));
      expect(error).toMatchObject({ name: "PermanentJobError", code: "export_stale" });
      expect(pdfCalls).toHaveLength(0);
      expect(store.keys()).toEqual([]);
      expect(await exportRows(job.id)).toHaveLength(0);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses an assessment that is no longer approved",
    async () => {
      const seeded = await seedApprovedAssessment(database, { ownerId: USER_A });
      const job = await enqueueAndClaim({
        assessmentId: seeded.assessmentId,
        snapshotHash: seeded.hash,
      });
      await asUser(database, USER_A, (tx) =>
        reopen(tx, { ownerId: USER_A, assessmentId: seeded.assessmentId }),
      );
      const { store, handler } = setup();
      const error = await rejection(handler(context(job)));
      expect(error).toMatchObject({ code: "export_not_approved" });
      expect(store.keys()).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses when a printed template field changed after approval",
    async () => {
      const seeded = await seedApprovedAssessment(database, { ownerId: USER_A });
      const job = await enqueueAndClaim({
        assessmentId: seeded.assessmentId,
        snapshotHash: seeded.hash,
      });
      await database.db
        .update(schoolTemplates)
        .set({ schoolName: "SMP Lain" })
        .where(eq(schoolTemplates.id, seeded.templateId));
      const { store, handler } = setup();
      const error = await rejection(handler(context(job)));
      expect(error).toMatchObject({ code: "export_stale" });
      expect(store.keys()).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "exports when only the template's name, default flag or row version changed (R26)",
    async () => {
      const seeded = await seedApprovedAssessment(database, { ownerId: USER_A });
      const job = await enqueueAndClaim({
        assessmentId: seeded.assessmentId,
        snapshotHash: seeded.hash,
      });
      await database.db
        .update(schoolTemplates)
        .set({
          name: "Nama lain",
          isDefault: true,
          rowVersion: sql`${schoolTemplates.rowVersion} + 3`,
        })
        .where(eq(schoolTemplates.id, seeded.templateId));
      const { handler } = setup();
      expect((await handler(context(job))).kind).toBe("done");
      expect(await exportRows(job.id)).toHaveLength(EXPORT_FILES.length);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses when the stored logo is not the approved one (replaced under the same key)",
    async () => {
      const seeded = await seedApprovedAssessment(database, { ownerId: USER_A });
      const key = `templates/${USER_A}/${seeded.templateId}/logo.svg`;
      const approved = new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>',
      );
      await database.db
        .update(schoolTemplates)
        .set({
          logoKey: key,
          logoSha256: createHash("sha256").update(approved).digest("hex"),
        })
        .where(eq(schoolTemplates.id, seeded.templateId));
      const hash = await reapprove(database, {
        ownerId: USER_A,
        assessmentId: seeded.assessmentId,
      });
      const job = await enqueueAndClaim({
        assessmentId: seeded.assessmentId,
        snapshotHash: hash,
      });
      const { store, handler } = setup();
      // The object was overwritten before its row was (a same-format upload in flight).
      await store.put(
        key,
        new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'),
        "image/svg+xml",
      );
      const error = await rejection(handler(context(job)));
      expect(error).toMatchObject({ code: "export_stale" });
      expect(store.keys()).toEqual([key]);

      // The approved bytes export.
      await store.put(key, approved, "image/svg+xml");
      const again = await enqueueAndClaim({
        assessmentId: seeded.assessmentId,
        snapshotHash: hash,
      });
      const ok = setup({ store });
      expect((await ok.handler(context(again))).kind).toBe("done");
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses another teacher's assessment, an unknown one and a malformed payload",
    async () => {
      const seeded = await seedApprovedAssessment(database, { ownerId: USER_A });
      // A job of B naming A's assessment: the handler reads as the job's owner only.
      const foreign = await enqueueAndClaim(
        { assessmentId: seeded.assessmentId, snapshotHash: seeded.hash },
        USER_B,
      );
      const { handler, store } = setup();
      expect(await rejection(handler(context(foreign)))).toMatchObject({
        code: "export_not_found",
      });
      expect(store.keys()).toEqual([]);
      const unknown = await enqueueAndClaim({
        assessmentId: "99999999-9999-4999-8999-999999999999",
        snapshotHash: seeded.hash,
      });
      expect(await rejection(handler(context(unknown)))).toMatchObject({
        code: "export_not_found",
      });
      const malformed = await enqueueAndClaim({ assessmentId: "x" });
      expect(await rejection(handler(context(malformed)))).toMatchObject({
        code: "export_invalid",
      });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "defers when the runner has too little time left to start an export",
    async () => {
      const seeded = await seedApprovedAssessment(database, { ownerId: USER_A });
      const job = await enqueueAndClaim({
        assessmentId: seeded.assessmentId,
        snapshotHash: seeded.hash,
      });
      const { handler, pdfCalls } = setup();
      const result = await handler(context(job, { deadline: Date.now() + 30_000 }));
      expect(result.kind).toBe("defer");
      expect(pdfCalls).toHaveLength(0);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "fails as too large when a PDF times out, is over the caps or has too many pages",
    async () => {
      const seeded = await seedApprovedAssessment(database, { ownerId: USER_A });
      const job = await enqueueAndClaim({
        assessmentId: seeded.assessmentId,
        snapshotHash: seeded.hash,
      });
      const timeouts: number[] = [];
      const slow = setup({
        renderPdf: (_doc, _kind, options) => {
          timeouts.push(options.timeoutMs);
          return Promise.reject(new RenderPdfError("timeout"));
        },
      });
      expect(await rejection(slow.handler(context(job)))).toMatchObject({
        code: "export_too_large",
      });
      // Each render is bounded by the PDF limit and by what is left of the export's budget.
      expect(timeouts[0]).toBeGreaterThan(0);
      expect(timeouts[0]).toBeLessThanOrEqual(60_000);
      expect(slow.store.keys()).toEqual([]);

      const big = setup({
        renderPdf: () => Promise.reject(new RenderPdfError("tooLarge")),
      });
      expect(await rejection(big.handler(context(job)))).toMatchObject({
        code: "export_too_large",
      });
      expect(big.store.keys()).toEqual([]);

      // The page count is the renderer's own (a 101-page result), not a count made here.
      const long = setup({
        renderPdf: () => Promise.resolve(fakeResult(MAX_PDF_PAGES + 1)),
      });
      expect(await rejection(long.handler(context(job)))).toMatchObject({
        code: "export_too_large",
      });
      expect(long.store.keys()).toEqual([]);
      expect(await exportRows(job.id)).toHaveLength(0);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "fails as a render failure, storing nothing, when the renderer throws",
    async () => {
      const seeded = await seedApprovedAssessment(database, { ownerId: USER_A });
      const job = await enqueueAndClaim({
        assessmentId: seeded.assessmentId,
        snapshotHash: seeded.hash,
      });
      const broken = setup({
        renderPdf: () => Promise.reject(new RenderPdfError("render")),
      });
      expect(await rejection(broken.handler(context(job)))).toMatchObject({
        code: "export_render_failed",
      });
      expect(broken.store.keys()).toEqual([]);
      expect(await exportRows(job.id)).toHaveLength(0);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "never waits for a renderer: an old progress with deferrals changes nothing",
    async () => {
      const seeded = await seedApprovedAssessment(database, { ownerId: USER_A });
      const job = await enqueueAndClaim({
        assessmentId: seeded.assessmentId,
        snapshotHash: seeded.hash,
      });
      const { handler, pdfCalls } = setup();
      const result = await handler(
        context(job, {
          progress: { step: "waiting", done: 0, total: 7, deferrals: 20 },
        }),
      );
      expect(result.kind).toBe("done");
      expect(pdfCalls).toHaveLength(3);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "gives the three PDFs of a job one shared math cache",
    async () => {
      const seeded = await seedApprovedAssessment(database, { ownerId: USER_A });
      const job = await enqueueAndClaim({
        assessmentId: seeded.assessmentId,
        snapshotHash: seeded.hash,
      });
      const caches = new Set<unknown>();
      const boxes = new Set<unknown>();
      const created = vi.spyOn(mathBox, "createMathCache");
      try {
        const { handler } = setup({
          renderPdf: (_doc, _kind, options) => {
            caches.add(options.math);
            // Each document asks for the same formula: the shared cache hands back one box.
            boxes.add(options.math("\\frac{1}{2}", false));
            return Promise.resolve(fakeResult());
          },
        });
        expect((await handler(context(job))).kind).toBe("done");
        expect(caches.size).toBe(1);
        expect(boxes.size).toBe(1);
        expect(created).toHaveBeenCalledTimes(1);
      } finally {
        created.mockRestore();
      }
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses a result with no page, so the page cap never lapses silently",
    async () => {
      const seeded = await seedApprovedAssessment(database, { ownerId: USER_A });
      const job = await enqueueAndClaim({
        assessmentId: seeded.assessmentId,
        snapshotHash: seeded.hash,
      });
      const opaque = setup({ renderPdf: () => Promise.resolve(fakeResult(0)) });
      expect(await rejection(opaque.handler(context(job)))).toMatchObject({
        code: "export_render_failed",
      });
      expect(opaque.store.keys()).toEqual([]);
      expect(await exportRows(job.id)).toHaveLength(0);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "keeps the warnings the renderer returned on the PDF rows, next to the missing-logo warning",
    async () => {
      const seeded = await seedApprovedAssessment(database, { ownerId: USER_A });
      await database.db
        .update(schoolTemplates)
        .set({ logoKey: `templates/${USER_A}/${seeded.templateId}/logo.png` })
        .where(eq(schoolTemplates.id, seeded.templateId));
      const hash = await reapprove(database, {
        ownerId: USER_A,
        assessmentId: seeded.assessmentId,
      });
      const job = await enqueueAndClaim({
        assessmentId: seeded.assessmentId,
        snapshotHash: hash,
      });
      const warning = {
        code: "mathFailed" as const,
        where: { part: "stem" as const, number: 1 },
        source: "\\bad",
      };
      const { handler } = setup({
        renderPdf: (_doc, kind) =>
          Promise.resolve(fakeResult(1, kind === "paper" ? [warning] : [])),
      });
      expect((await handler(context(job))).kind).toBe("done");
      const rows = await exportRows(job.id);
      const pdf = (kind: string) =>
        rows.find((r) => r.document === kind && r.format === "pdf")?.warnings;
      const missing = { code: "logoMissing", where: { part: "letterhead" } };
      expect(pdf("paper")).toEqual([warning, missing]);
      expect(pdf("key")).toEqual([missing]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "leaves an SVG logo out of the PDF and Word rows with a logoOmitted warning",
    async () => {
      const seeded = await seedApprovedAssessment(database, { ownerId: USER_A });
      const key = `templates/${USER_A}/${seeded.templateId}/logo.svg`;
      const svg = new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>',
      );
      await database.db
        .update(schoolTemplates)
        .set({ logoKey: key, logoSha256: createHash("sha256").update(svg).digest("hex") })
        .where(eq(schoolTemplates.id, seeded.templateId));
      const hash = await reapprove(database, {
        ownerId: USER_A,
        assessmentId: seeded.assessmentId,
      });
      const job = await enqueueAndClaim({
        assessmentId: seeded.assessmentId,
        snapshotHash: hash,
      });
      const store = recordingStore();
      await store.put(key, svg, "image/svg+xml");
      // The real renderer: the omission is decided by the PDF components, not by the job.
      const handler = createRenderExportHandler({ db: db(), store, now: () => NOW });
      expect((await handler(context(job))).kind).toBe("done");
      const rows = await exportRows(job.id);
      for (const row of rows.filter((r) => r.document !== "zip")) {
        expect(row.warnings, `${row.document}.${row.format}`).toContainEqual({
          code: "logoOmitted",
          where: { part: "letterhead" },
          source: "image/svg+xml",
        });
      }
    },
    DB_TEST_TIMEOUT * 6,
  );

  it(
    "keeps the warnings of each file on its row (a formula Word could not convert)",
    async () => {
      const seeded = await seedApprovedAssessment(database, { ownerId: USER_A });
      // A formula KaTeX renders for the PDF but Word's converter refuses (\phantom). Versions
      // are immutable (a trigger refuses every update), so the fixture bypasses triggers.
      await database.db.transaction(async (tx) => {
        await tx.execute(sql`set local session_replication_role = replica`);
        await tx.execute(
          sql`update question_versions set stem_md = 'Hitung $\\phantom{x}y$.' where question_id = ${seeded.questionIds[0]}`,
        );
      });
      const job = await enqueueAndClaim({
        assessmentId: seeded.assessmentId,
        snapshotHash: seeded.hash,
      });
      const { handler } = setup();
      await handler(context(job));
      const rows = await exportRows(job.id);
      const paperDocx = rows.find((r) => r.document === "paper" && r.format === "docx");
      const paperPdf = rows.find((r) => r.document === "paper" && r.format === "pdf");
      expect(paperDocx?.warnings).toEqual([
        expect.objectContaining({
          code: "mathFailed",
          where: { part: "stem", number: expect.any(Number) as number },
        }),
      ]);
      expect(paperPdf?.warnings).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "warns on every document when the template's logo file is missing from storage",
    async () => {
      const seeded = await seedApprovedAssessment(database, { ownerId: USER_A });
      // The template names its own logo (approved with it), but the object is gone.
      await database.db
        .update(schoolTemplates)
        .set({ logoKey: `templates/${USER_A}/${seeded.templateId}/logo.png` })
        .where(eq(schoolTemplates.id, seeded.templateId));
      const hash = await reapprove(database, {
        ownerId: USER_A,
        assessmentId: seeded.assessmentId,
      });
      const job = await enqueueAndClaim({
        assessmentId: seeded.assessmentId,
        snapshotHash: hash,
      });
      const { handler } = setup();
      expect((await handler(context(job))).kind).toBe("done");
      const rows = await exportRows(job.id);
      for (const row of rows.filter((r) => r.document !== "zip")) {
        expect(row.warnings, `${row.document}.${row.format}`).toContainEqual({
          code: "logoMissing",
          where: { part: "letterhead" },
        });
      }
      expect(rows.find((r) => r.document === "zip")?.warnings).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("exportRowId", () => {
  it("is a stable uuid per job and file, different for every file", () => {
    const job = "33333333-3333-4333-8333-333333333333";
    const ids = EXPORT_FILES.map((file) => exportRowId(job, file));
    expect(new Set(ids).size).toBe(7);
    for (const id of ids)
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    expect(exportRowId(job, EXPORT_FILES[0])).toBe(ids[0]);
    expect(exportRowId("44444444-4444-4444-8444-444444444444", EXPORT_FILES[0])).not.toBe(
      ids[0],
    );
  });
});

// The real renderer, never skipped (no binary is needed): full exports end to end.
describe("render_export with React-PDF", () => {
  it(
    "renders three real PDFs and three Word files",
    async () => {
      const seeded = await seedApprovedAssessment(database, { ownerId: USER_A });
      const job = await enqueueAndClaim({
        assessmentId: seeded.assessmentId,
        snapshotHash: seeded.hash,
      });
      const store = recordingStore();
      const handler = createRenderExportHandler({ db: db(), store, now: () => NOW });
      expect((await handler(context(job))).kind).toBe("done");
      const prefix = exportPrefix(USER_A, job.id);
      for (const kind of ["paper", "key", "solutions"]) {
        const pdf = await store.get(`${prefix}${kind}.pdf`);
        expect(new TextDecoder().decode(pdf?.slice(0, 5))).toBe("%PDF-");
        expect(countPdfPages(pdf ?? new Uint8Array())).toBeGreaterThan(0);
        const docx = await store.get(`${prefix}${kind}.docx`);
        expect([...(docx ?? []).slice(0, 2)]).toEqual([0x50, 0x4b]);
      }
      const rows = await database.db
        .select()
        .from(exports)
        .where(and(eq(exports.jobId, job.id), eq(exports.ownerId, USER_A)));
      expect(rows).toHaveLength(7);
    },
    DB_TEST_TIMEOUT * 6,
  );

  it("exports the largest assessment (200 items, 10 sections, two formulas per stem) or refuses it as too large, within the budget", async () => {
    const seeded = await seedApprovedAssessment(database, {
      ownerId: USER_A,
      count: 200,
      sections: 10,
    });
    // Versions are immutable (a trigger refuses every update): the fixture bypasses triggers.
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.execute(
        sql`update question_versions set stem_md = 'Hitung $\\frac{1}{2} + x^{2}$ lalu $\\sqrt{3} \\cdot y$.' where question_id in ${seeded.questionIds}`,
      );
    });
    const job = await enqueueAndClaim({
      assessmentId: seeded.assessmentId,
      snapshotHash: seeded.hash,
    });
    const store = recordingStore();
    const handler = createRenderExportHandler({ db: db(), store, now: () => NOW });
    const started = Date.now();
    // Done, or a typed too-large refusal: never the runner's own deadline.
    const outcome = await handler(context(job)).then(
      (result) => result.kind,
      (error: unknown) => error,
    );
    expect(Date.now() - started).toBeLessThan(90_000);
    if (outcome === "done") {
      expect(await exportRows(job.id)).toHaveLength(EXPORT_FILES.length);
    } else {
      expect(outcome).toMatchObject({ code: "export_too_large" });
      expect(store.keys()).toEqual([]);
      expect(await exportRows(job.id)).toHaveLength(0);
    }
  }, 180_000);
});
