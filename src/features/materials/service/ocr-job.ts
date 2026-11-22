import "server-only";
// Job `ocr_pages` (decision 5): one page at a time, paced by the vision model's output-per-minute
// budget (1,000 tokens; a page reserves 900, so about one page a minute) across every run and
// process: the budget is seeded from ai_calls and each call is booked there first, dated at the
// minute slot it will use, under the model's advisory lock (Ruling R19 provisional rows). Per page:
// 1. The image: a staging upload is checked (PNG signature, size, dimensions, not blank; R11
//    pattern) and, under the material's row lock with the material still live, copied to its
//    final key `materials/<ownerId>/<materialId>/pages/<n>.png` (never signed for a PUT; the trash
//    purge deletes that prefix); an image material's own file is used after its sha-256 check.
//    The raw size is checked before any base64.
// 2. The model call (task ocr_page, C2, at most 900 output tokens, the job's deadline): the answer
//    is JSON {markdown}; `[[?]]` marks uncertain parts. An answer that used the whole output cap is
//    flagged `truncated`.
// 3. Post-check: every LaTeX span must parse with KaTeX; a failure or a marker flags
//    `uncertain_math`. The page is written (text_source `ocr`, ocr_status `done`) under the
//    material's row lock, only while the material is live and the page still `queued`.
// Usage is counted when pages are queued; a page that ends with no model call (image missing or
// refused, policy refusal, a job that fails for good) is given back. A material moved to the
// trash ends its queued pages `failed` without a refund (R20 ruling: no AI was spent). A retried
// job only OCRs pages still `queued`, so a done page is never sent again and never counted twice.
// Logs carry codes, never page content.
import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  AiImageError,
  AiOutputError,
  AiPolicyError,
  AiProviderError,
  AiQuotaError,
  defaultRouting,
  TokenBudget,
  type AiUsage,
} from "@/lib/ai";
import { MAX_OUTPUT_WAIT_MS } from "@/lib/ai/budget";
import { safeErrorSummary } from "@/lib/db/error-summary";
import { stripImageMetadata } from "@/lib/images/strip-metadata";
import { aiCalls, jobs, materialPages, materials } from "@/lib/db/schema";
import {
  PermanentJobError,
  RetryableJobError,
  type HandlerResult,
  type JobContext,
  type JobHandler,
} from "@/lib/jobs/handler";
import type { Progress } from "@/lib/jobs/types";
import { logger } from "@/lib/logger";
import type { ObjectStore } from "@/lib/storage/types";
import {
  aiErrorCode,
  findInvalidMathSpans,
  lockWaitMs,
  pgCodeOf,
  planQuota,
  providerRetryDelayMs,
  QUOTA_RETRY_MS,
  type Gateway,
} from "@/features/generation";
import {
  MAX_PAGE_IMAGE_BYTES,
  MAX_PAGES_PER_REQUEST,
  OCR_PAGES_JOB,
  ocrAnswerSchema,
  type OcrPageFailure,
} from "../schema/ocr";
import { refundOcrPages } from "./ocr-quota";
import { cleanPageText, pageQuality, type PageConfidence } from "./page-quality";
import { buildOcrPagePrompt, OCR_PAGE_PROMPT_VERSION } from "./prompts/ocr-page.id";
import type { MaterialDb } from "./upload";
import {
  checkPageImage,
  JPEG_SIGNATURE,
  liveJobListsPage,
  liveMaterial,
  needsPageUpload,
  pageImageKey,
  pageStagingKey,
  PNG_SIGNATURE,
  startsWith,
} from "./ocr-queue";
import { refreshMaterialStatus } from "./ocr-review";

const TASK = "ocr_page";
/** The solver's photo-reading jobs (solver/schema/solver.ts EXTRACT_PROBLEM_JOB). */
const PHOTO_READ_JOB = "extract_problem";
const ROUTE = defaultRouting.ocr_page[0];
if (ROUTE.otpm === undefined) throw new Error("ocr_page: the vision route must be paced");
/** The output a page may use (the route's cap, decision 5). */
export const OCR_MAX_OUTPUT_TOKENS = ROUTE.maxOutputTokens;
const OTPM = ROUTE.otpm;
/**
 * The vision model's shared free-tier budget as this app plans it. Groq publishes only the 1,000
 * output tokens a minute for it (extraction spike); the totals are the ones the other Groq models
 * use and are an estimate. A spent day defers the job (decision 9: no fallback provider).
 */
export const OCR_QUOTA = { perMinute: 8_000, perDay: 200_000 } as const;
/** About one page: the prompt, one image (2,048 tokens) and the reserved output. */
const PAGE_ESTIMATE_TOKENS = 3_300;
/** A model call (30 s timeout) and the writes after it. */
const CALL_BUDGET_MS = 35_000;
/** A page starts only with this much of the runner's budget left (image, call, writes). */
export const MIN_PAGE_MS = 45_000;
/** The ai_calls error code of a booked, not yet settled vision call (R19). */
export const RESERVED = "reserved";
const STUCK_PAGE_BATCH = 500;

// ---------------------------------------------------------------------------------------------
// The post-check

export type OcrFlag = "uncertain_math" | "low_text" | "garbled" | "truncated";
export interface OcrPageText {
  textMd: string;
  confidence: PageConfidence;
  flags: OcrFlag[];
}

/**
 * The stored text of one OCR answer and how far it can be trusted ("perlu diperiksa" whenever it
 * is not high): `uncertain_math` for a `[[?]]` marker or a LaTeX span KaTeX cannot parse,
 * `truncated` when the answer used the whole output cap, `low_text`/`garbled` as for a text
 * layer. Low for low_text or garbled, medium for the other flags, high otherwise.
 */
export function ocrPageText(
  markdown: string,
  input: { truncated: boolean },
): OcrPageText {
  const textMd = cleanPageText(markdown);
  const quality = pageQuality(textMd);
  const flags: OcrFlag[] = [];
  if (textMd.includes("[[?]]") || findInvalidMathSpans(textMd).length > 0) {
    flags.push("uncertain_math");
  }
  if (quality.flags.includes("low_text")) flags.push("low_text");
  if (quality.flags.includes("garbled")) flags.push("garbled");
  if (input.truncated) flags.push("truncated");
  const confidence: PageConfidence =
    flags.includes("low_text") || flags.includes("garbled")
      ? "low"
      : flags.length > 0
        ? "medium"
        : "high";
  return { textMd, confidence, flags };
}

// ---------------------------------------------------------------------------------------------
// The job

const payloadSchema = z.object({
  materialId: z.uuid(),
  pageNos: z.array(z.number().int().min(1)).min(1).max(MAX_PAGES_PER_REQUEST),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
type Payload = z.infer<typeof payloadSchema>;

type Material = Pick<
  typeof materials.$inferSelect,
  "id" | "ownerId" | "kind" | "sha256" | "objectKey" | "sizeBytes"
>;

type PageImage =
  | { ok: true; base64: string; mime: "image/png" | "image/jpeg" }
  | { ok: false; failure: OcrPageFailure };

export interface VisionSpend {
  at: Date;
  input: number;
  output: number;
  /** What the call holds in the output-per-minute window. */
  slot: number;
}

/**
 * What the vision model spent in the last day, across owners and runs (service connection). Groq
 * counts a request's whole max_tokens toward the output-per-minute limit (the spike's refusal named
 * the requested figure), so a call that was sent (answered, or still booked) holds at least the
 * route's cap in the output window, whatever it really produced.
 */
export async function readVisionSpends(
  db: MaterialDb,
  now: Date,
): Promise<VisionSpend[]> {
  const rows = await db
    .select({
      at: aiCalls.createdAt,
      input: aiCalls.inputTokens,
      output: aiCalls.outputTokens,
      outcome: aiCalls.outcome,
      errorCode: aiCalls.errorCode,
    })
    .from(aiCalls)
    .where(
      and(
        eq(aiCalls.model, ROUTE.model),
        gt(aiCalls.createdAt, new Date(now.getTime() - 86_400_000)),
      ),
    );
  return rows.map((row) => {
    const output = row.output ?? 0;
    const sent = row.outcome === "ok" || row.errorCode === RESERVED || output > 0;
    return {
      at: row.at,
      input: row.input ?? 0,
      output,
      slot: sent ? Math.max(output, OCR_MAX_OUTPUT_TOKENS) : 0,
    };
  });
}

/**
 * Ruling R28: one teacher may use at most this share of the vision model's day (rolling, across
 * OCR pages and solver photo reads), so no one can take more than a quarter of everyone's reads.
 */
export const VISION_TEACHER_SHARE = 0.25;

/** Whether one more call of `estimate` tokens fits the teacher's share; else when it will. */
export async function teacherVisionPlan(
  db: MaterialDb,
  input: { ownerId: string; estimate: number; now: Date },
): Promise<ReturnType<typeof planQuota>> {
  const rows = await db
    .select({
      at: aiCalls.createdAt,
      input: aiCalls.inputTokens,
      output: aiCalls.outputTokens,
    })
    .from(aiCalls)
    .where(
      and(
        eq(aiCalls.model, ROUTE.model),
        eq(aiCalls.ownerId, input.ownerId),
        gt(aiCalls.createdAt, new Date(input.now.getTime() - 86_400_000)),
      ),
    );
  return planQuota({
    spends: rows.map((row) => ({
      at: row.at,
      tokens: (row.input ?? 0) + (row.output ?? 0),
    })),
    estimate: input.estimate,
    perDay: Math.floor(OCR_QUOTA.perDay * VISION_TEACHER_SHARE),
    now: input.now,
  });
}

/** A gateway budget that already holds every spend (and output slot) other runs booked. */
export function visionBudget(
  spends: readonly VisionSpend[],
  now: () => number,
  sleep: ((ms: number) => Promise<void>) | undefined,
): TokenBudget {
  const budget = new TokenBudget(OCR_QUOTA, now, sleep);
  budget.seed(
    ROUTE.model,
    spends.map((spend) => ({
      at: spend.at.getTime(),
      tokens: spend.input + spend.output,
    })),
  );
  budget.seedOutput(
    ROUTE.model,
    spends.map((spend) => ({ at: spend.at.getTime(), tokens: spend.slot })),
  );
  return budget;
}

export interface OcrPagesDeps {
  db: MaterialDb;
  store: ObjectStore;
  createGateway: (budget: TokenBudget) => Gateway;
  now?: () => Date;
  /** The budget's wait for the output slot (tests pass a fake clock's sleep). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * False only with the e2e fake AI (its answers spend nothing): pages are not spaced out by the
   * output-per-minute budget.
   */
  paced?: boolean;
}

const FAILURE_MESSAGES = {
  ocr_invalid: "The OCR job payload is not valid.",
  ocr_not_found: "The material of the OCR job was not found.",
  ocr_blocked: "The material cannot be sent to the AI.",
  provider_unavailable: "The AI service is not available; it will be retried.",
} as const;

export function createOcrPagesHandler(deps: OcrPagesDeps): JobHandler {
  const { db, store } = deps;

  /** Whether a solver photo reading (any teacher's) is due and waiting for the runner. */
  async function photoReadWaiting(now: Date): Promise<boolean> {
    const rows = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, PHOTO_READ_JOB),
          inArray(jobs.status, ["queued", "deferred"]),
          lte(jobs.runAfter, now),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
  const clock = deps.now ?? (() => new Date());
  const paced = deps.paced ?? true;

  const ofPage = (material: Material, pageNo: number) =>
    and(
      eq(materialPages.materialId, material.id),
      eq(materialPages.ownerId, material.ownerId),
      eq(materialPages.pageNo, pageNo),
    );

  /** Locks the material's row (shared) and says whether it is still live. */
  async function lockLive(tx: MaterialDb, material: Material): Promise<boolean> {
    const rows = await tx
      .select({ id: materials.id })
      .from(materials)
      .where(liveMaterial(material.ownerId, material.id))
      .for("share");
    return rows.length > 0;
  }

  /** Ends queued pages without text: `failed`, given back to the cap when `refund`. */
  async function failPages(
    material: Material,
    payload: Payload,
    pageNos: number[],
    refund: boolean,
  ): Promise<void> {
    if (pageNos.length === 0) return;
    const now = clock();
    const failed = await db
      .update(materialPages)
      .set({ ocrStatus: "failed", updatedAt: now })
      .where(
        and(
          eq(materialPages.materialId, material.id),
          eq(materialPages.ownerId, material.ownerId),
          inArray(materialPages.pageNo, pageNos),
          eq(materialPages.ocrStatus, "queued"),
        ),
      )
      .returning({ pageNo: materialPages.pageNo });
    if (refund && failed.length > 0) {
      await refundOcrPages(db, {
        ownerId: material.ownerId,
        day: payload.day,
        pages: failed.length,
        now,
      });
    }
  }

  async function queuedPages(material: Material, payload: Payload): Promise<number[]> {
    const rows = await db
      .select({ pageNo: materialPages.pageNo })
      .from(materialPages)
      .where(
        and(
          eq(materialPages.materialId, material.id),
          eq(materialPages.ownerId, material.ownerId),
          inArray(materialPages.pageNo, payload.pageNos),
          eq(materialPages.ocrStatus, "queued"),
        ),
      )
      .orderBy(asc(materialPages.pageNo));
    return rows.map((row) => row.pageNo);
  }

  /** The image of one page, checked; a staging upload is moved to the page's own key first. */
  /**
   * A staged upload of the page, checked and moved to the page's own key under the material's row
   * lock (a trash purge, FOR UPDATE, waits for this write and then deletes the whole prefix; a
   * trashed material gets no new file). `none` when nothing is staged.
   */
  async function promoteStaged(
    material: Material,
    pageNo: number,
  ): Promise<"none" | "moved" | OcrPageFailure> {
    const stagingKey = pageStagingKey(material.ownerId, material.id, pageNo);
    const staged = await store.get(stagingKey);
    if (!staged) return "none";
    const checked = checkPageImage(staged);
    if (!checked.ok) {
      await store.delete(stagingKey);
      return checked.error;
    }
    const live = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as MaterialDb;
      if (!(await lockLive(tx, material))) return false;
      await store.put(
        pageImageKey(material.ownerId, material.id, pageNo),
        staged,
        "image/png",
      );
      // The kept image counts toward the teacher's storage cap.
      await tx
        .update(materialPages)
        .set({ imageBytes: staged.length })
        .where(ofPage(material, pageNo));
      return true;
    });
    await store.delete(stagingKey);
    return live ? "moved" : "material_gone";
  }

  async function loadPageImage(material: Material, pageNo: number): Promise<PageImage> {
    if (material.kind === "image" && !needsPageUpload(material)) {
      if (pageNo !== 1) return { ok: false, failure: "image_missing" };
      const bytes = await store.get(material.objectKey);
      if (!bytes) return { ok: false, failure: "image_missing" };
      // Raw size first: nothing larger is hashed or encoded.
      if (bytes.length > MAX_PAGE_IMAGE_BYTES)
        return { ok: false, failure: "image_too_large" };
      if (createHash("sha256").update(bytes).digest("hex") !== material.sha256) {
        return { ok: false, failure: "image_invalid" };
      }
      const mime = startsWith(bytes, PNG_SIGNATURE)
        ? "image/png"
        : startsWith(bytes, JPEG_SIGNATURE)
          ? "image/jpeg"
          : null;
      if (!mime) return { ok: false, failure: "image_invalid" };
      // A teacher's photo: its Exif (GPS, device, time), XMP and text chunks never reach the model.
      const clean = stripImageMetadata(bytes, mime);
      if (!clean) return { ok: false, failure: "image_invalid" };
      return { ok: true, base64: Buffer.from(clean).toString("base64"), mime };
    }
    if (!needsPageUpload(material)) return { ok: false, failure: "image_missing" };

    const moved = await promoteStaged(material, pageNo);
    if (moved !== "none" && moved !== "moved") return { ok: false, failure: moved };
    const finalKey = pageImageKey(material.ownerId, material.id, pageNo);
    const stored = await store.get(finalKey);
    if (!stored) return { ok: false, failure: "image_missing" };
    const checked = checkPageImage(stored);
    if (!checked.ok) return { ok: false, failure: checked.error };
    const clean = stripImageMetadata(stored, "image/png");
    if (!clean) return { ok: false, failure: "image_invalid" };
    return {
      ok: true,
      base64: Buffer.from(clean).toString("base64"),
      mime: "image/png",
    };
  }

  type Booking =
    | { kind: "gone" }
    | { kind: "later"; at: Date }
    | { kind: "booked"; spends: VisionSpend[]; reservationId: string };

  /**
   * Under the model's lock (every OCR run takes it): the material is still live, the day's budget
   * has room and the next output slot starts in time; then the call is booked in ai_calls, dated
   * at that slot, so every other run counts it from now on.
   */
  async function book(ctx: JobContext, material: Material): Promise<Booking> {
    const waitMs = lockWaitMs(ctx.deadline, clock().getTime());
    return db.transaction(async (rawTx): Promise<Booking> => {
      const tx = rawTx as unknown as MaterialDb;
      await tx.execute(sql.raw(`set local lock_timeout = '${String(waitMs)}ms'`));
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`ai:${ROUTE.model}`}, 0))`,
      );
      await tx.execute(sql.raw("set local lock_timeout = 0"));
      if (!(await lockLive(tx, material))) return { kind: "gone" };
      const now = clock();
      const spends = await readVisionSpends(tx, now);
      const plan = planQuota({
        spends: spends.map((spend) => ({
          at: spend.at,
          tokens: spend.input + spend.output,
        })),
        estimate: PAGE_ESTIMATE_TOKENS,
        perDay: OCR_QUOTA.perDay,
        now,
      });
      if (!plan.ok) return { kind: "later", at: plan.error.resumeAt };
      const mine = await teacherVisionPlan(tx, {
        ownerId: material.ownerId,
        estimate: PAGE_ESTIMATE_TOKENS,
        now,
      });
      if (!mine.ok) return { kind: "later", at: mine.error.resumeAt };
      const slotWait = paced
        ? visionBudget(spends, () => now.getTime(), undefined).outputWaitMs(
            ROUTE.model,
            OCR_MAX_OUTPUT_TOKENS,
            OTPM,
          )
        : 0;
      const slot = now.getTime() + slotWait;
      if (slotWait > MAX_OUTPUT_WAIT_MS || slot > ctx.deadline - CALL_BUDGET_MS) {
        return {
          kind: "later",
          at: new Date(Number.isFinite(slot) ? slot : now.getTime() + QUOTA_RETRY_MS),
        };
      }
      // One row per page. A repair attempt inside the same generate() is a second call holding up
      // to 900 more output tokens in the same minute; it is settled into this row (summed usage,
      // one timestamp), so concurrent runs may briefly over-book the OTPM window. Groq then
      // answers 429, which defers the job (rate_limited), so the overshoot is bounded.
      const [reservation] = await tx
        .insert(aiCalls)
        .values({
          ownerId: material.ownerId,
          jobId: ctx.job.id,
          task: TASK,
          provider: ROUTE.provider,
          model: ROUTE.model,
          promptVersion: OCR_PAGE_PROMPT_VERSION,
          inputTokens: PAGE_ESTIMATE_TOKENS - OCR_MAX_OUTPUT_TOKENS,
          outputTokens: OCR_MAX_OUTPUT_TOKENS,
          outcome: "error",
          errorCode: RESERVED,
          createdAt: new Date(slot),
        })
        .returning({ id: aiCalls.id });
      return { kind: "booked", spends, reservationId: reservation.id };
    });
  }

  /** Writes one page's OCR text, only while the material is live and the page still queued. */
  async function writePage(
    material: Material,
    pageNo: number,
    text: OcrPageText,
  ): Promise<"written" | "gone" | "skipped"> {
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as MaterialDb;
      if (!(await lockLive(tx, material))) return "gone" as const;
      const now = clock();
      const written = await tx
        .update(materialPages)
        .set({
          textMd: text.textMd,
          textSource: "ocr",
          confidence: text.confidence,
          flags: text.flags,
          ocrStatus: "done",
          reviewedAt: null,
          updatedAt: now,
        })
        .where(and(ofPage(material, pageNo), eq(materialPages.ocrStatus, "queued")))
        .returning({ id: materialPages.id });
      if (written.length === 0) return "skipped" as const;
      await refreshMaterialStatus(tx, {
        ownerId: material.ownerId,
        materialId: material.id,
        now,
      });
      return "written" as const;
    });
  }

  /** Ends a job's queued pages for good; `called` (if any) reached the model and stays counted. */
  async function giveUp(material: Material, payload: Payload, called: number | null) {
    try {
      const rest = await queuedPages(material, payload);
      await failPages(
        material,
        payload,
        rest.filter((n) => n !== called),
        true,
      );
      if (called !== null && rest.includes(called)) {
        await failPages(material, payload, [called], false);
      }
    } catch (error) {
      // The stuck-page sweep (sweepStuckOcrPages) ends them on the next daily run.
      logger.error(
        { module: "materials", err: safeErrorSummary(error) },
        "materials: could not end the pages of a failed OCR job",
      );
    }
  }

  return async (ctx) => {
    const parsed = payloadSchema.safeParse(ctx.job.payload);
    if (!parsed.success) {
      throw new PermanentJobError("ocr_invalid", FAILURE_MESSAGES.ocr_invalid);
    }
    const payload = parsed.data;
    const material = (
      await db
        .select({
          id: materials.id,
          ownerId: materials.ownerId,
          kind: materials.kind,
          sha256: materials.sha256,
          objectKey: materials.objectKey,
          sizeBytes: materials.sizeBytes,
          deletedAt: materials.deletedAt,
        })
        .from(materials)
        .where(
          and(eq(materials.id, payload.materialId), eq(materials.ownerId, ctx.ownerId)),
        )
    ).at(0);
    // Absent or another owner's: nothing of it is touched.
    if (!material) {
      throw new PermanentJobError("ocr_not_found", FAILURE_MESSAGES.ocr_not_found);
    }
    const total = payload.pageNos.length;
    const previous = ctx.progress?.done ?? 0;
    let done = Number.isSafeInteger(previous) && previous > 0 ? previous : 0;
    const progress = (step: string): Progress => ({ step, done, total });
    const stop = async (): Promise<HandlerResult> => {
      await failPages(material, payload, await queuedPages(material, payload), true);
      return { kind: "done", progress: progress("material_gone") };
    };
    if (material.deletedAt) return await stop();

    // The page whose model call was sent and whose outcome is not stored yet.
    let called: number | null = null;
    try {
      // Every staged picture of the job is checked and kept now, not when its page's turn comes:
      // a job deferred for long (the vision model's day budget) must not outlive the uploads/
      // lifecycle rule (1 day). A refused picture ends its page at once.
      if (needsPageUpload(material)) {
        for (const pageNo of await queuedPages(material, payload)) {
          let moved: Awaited<ReturnType<typeof promoteStaged>>;
          try {
            moved = await promoteStaged(material, pageNo);
          } catch (error) {
            logger.error(
              { module: "materials", jobId: ctx.job.id, err: safeErrorSummary(error) },
              "materials: could not keep an OCR page image",
            );
            throw new RetryableJobError(
              "provider_unavailable",
              FAILURE_MESSAGES.provider_unavailable,
            );
          }
          if (moved === "material_gone") return await stop();
          if (moved !== "none" && moved !== "moved") {
            logger.warn(
              { module: "materials", jobId: ctx.job.id, code: moved },
              "materials: OCR page refused",
            );
            await failPages(material, payload, [pageNo], true);
          }
        }
      }
      for (;;) {
        const pending = await queuedPages(material, payload);
        if (pending.length === 0) return { kind: "done", progress: progress("done") };
        if (ctx.deadline - clock().getTime() < MIN_PAGE_MS) {
          return {
            kind: "defer",
            runAfter: new Date(ctx.deadline),
            progress: progress("pages"),
          };
        }
        // A teacher waiting on a photo reading gets the next vision slot: this job steps
        // aside and the runner claims the reading (higher priority) first.
        if (await photoReadWaiting(clock())) {
          return { kind: "defer", runAfter: clock(), progress: progress("pages") };
        }
        const pageNo = pending[0];

        let image: PageImage;
        try {
          image = await loadPageImage(material, pageNo);
        } catch (error) {
          logger.error(
            { module: "materials", jobId: ctx.job.id, err: safeErrorSummary(error) },
            "materials: could not load an OCR page image",
          );
          throw new RetryableJobError(
            "provider_unavailable",
            FAILURE_MESSAGES.provider_unavailable,
          );
        }
        if (!image.ok) {
          if (image.failure === "material_gone") return await stop();
          logger.warn(
            { module: "materials", jobId: ctx.job.id, code: image.failure },
            "materials: OCR page refused",
          );
          await failPages(material, payload, [pageNo], true);
          continue;
        }

        let booked: Booking;
        try {
          booked = await book(ctx, material);
        } catch (error) {
          if (pgCodeOf(error) === "55P03") {
            return {
              kind: "defer",
              runAfter: new Date(ctx.deadline),
              progress: progress("pages"),
            };
          }
          throw error;
        }
        if (booked.kind === "gone") return await stop();
        if (booked.kind === "later") {
          return { kind: "defer", runAfter: booked.at, progress: progress("pages") };
        }

        const { reservationId } = booked;
        const spent: AiUsage = { inputTokens: 0, outputTokens: 0 };
        let hitCap = false as boolean;
        const startedAt = clock().getTime();
        const ours = and(eq(aiCalls.id, reservationId), eq(aiCalls.errorCode, RESERVED));
        const settle = (outcome: "ok" | "error", errorCode: string | null) =>
          db
            .update(aiCalls)
            .set({
              inputTokens: spent.inputTokens,
              outputTokens: spent.outputTokens,
              latencyMs: clock().getTime() - startedAt,
              outcome,
              errorCode,
            })
            .where(ours);
        const { system, prompt } = buildOcrPagePrompt();
        let markdown: string;
        called = pageNo;
        try {
          const result = await deps
            .createGateway(
              visionBudget(booked.spends, () => clock().getTime(), deps.sleep),
            )
            .generate({
              task: TASK,
              dataClass: "C2",
              system,
              prompt,
              images: [{ mime: image.mime, base64: image.base64 }],
              maxOutputTokens: OCR_MAX_OUTPUT_TOKENS,
              deadline: ctx.deadline - CALL_BUDGET_MS,
              onUsage: (usage) => {
                spent.inputTokens += usage.inputTokens;
                spent.outputTokens += usage.outputTokens;
                hitCap = usage.outputTokens >= OCR_MAX_OUTPUT_TOKENS;
              },
              parse: (raw) => ocrAnswerSchema.parse(raw),
            });
          markdown = result.value.markdown;
        } catch (error) {
          await settle("error", aiErrorCode(error));
          if (error instanceof AiQuotaError) {
            called = null;
            return {
              kind: "defer",
              runAfter: new Date(clock().getTime() + QUOTA_RETRY_MS),
              progress: progress("pages"),
            };
          }
          if (error instanceof AiProviderError && error.kind === "rate_limited") {
            called = null;
            return {
              kind: "defer",
              runAfter: new Date(
                clock().getTime() + providerRetryDelayMs(error.retryAfterMs),
              ),
              progress: progress("pages"),
            };
          }
          if (error instanceof AiImageError) {
            // Refused before anything was sent: the page goes back to the cap.
            called = null;
            await failPages(material, payload, [pageNo], true);
            continue;
          }
          if (error instanceof AiOutputError) {
            // The model answered (and spent): the page counts, the teacher may type it instead.
            logger.warn(
              {
                module: "materials",
                jobId: ctx.job.id,
                code: hitCap ? "truncated" : "invalid_output",
              },
              "materials: OCR answer unusable",
            );
            called = null;
            await failPages(material, payload, [pageNo], false);
            continue;
          }
          if (error instanceof AiPolicyError) {
            // Refused before anything was sent.
            called = null;
            throw new PermanentJobError("ocr_blocked", FAILURE_MESSAGES.ocr_blocked);
          }
          throw new RetryableJobError(
            "provider_unavailable",
            FAILURE_MESSAGES.provider_unavailable,
          );
        }
        await settle("ok", null);
        const written = await writePage(
          material,
          pageNo,
          ocrPageText(markdown, { truncated: hitCap }),
        );
        called = null;
        if (written === "gone") return await stop();
        if (written === "written") done += 1;
      }
    } catch (error) {
      // The job fails for good (a permanent error, or the last attempt): its queued pages end
      // `failed` and every page that never reached the model goes back to the cap.
      if (
        error instanceof PermanentJobError ||
        ctx.job.attempts + 1 >= ctx.job.maxAttempts
      ) {
        await giveUp(material, payload, called);
      }
      throw error;
    }
  };
}

/**
 * The daily run's backstop for a job that died without giving up (its function was killed
 * until the runner's stale-lease reclaim failed it): pages still `queued` that no live job lists
 * end `failed` and go back to the cap of the day their newest job counted them on (which page,
 * if any, reached the model is unknown here; giving it back is the teacher-friendly side).
 * Returns how many pages were ended. Idempotent.
 */
export async function sweepStuckOcrPages(
  db: MaterialDb,
  now: Date,
  options: { batch?: number } = {},
): Promise<number> {
  const dayOfJob = sql<string | null>`(select ${jobs.payload}->>'day' from ${jobs}
    where ${jobs.ownerId} = "material_pages"."owner_id"
      and ${jobs.type} = ${OCR_PAGES_JOB}
      and ${jobs.payload}->>'materialId' = "material_pages"."material_id"::text
      and ${jobs.payload}->'pageNos' @> to_jsonb("material_pages"."page_no")
    order by ${jobs.createdAt} desc limit 1)`;
  const stuck = await db
    .select({
      id: materialPages.id,
      ownerId: materialPages.ownerId,
      day: dayOfJob,
    })
    .from(materialPages)
    .where(and(eq(materialPages.ocrStatus, "queued"), sql`not ${liveJobListsPage}`))
    .limit(options.batch ?? STUCK_PAGE_BATCH);
  let ended = 0;
  for (const page of stuck) {
    const updated = await db
      .update(materialPages)
      .set({ ocrStatus: "failed", updatedAt: now })
      .where(
        and(
          eq(materialPages.id, page.id),
          eq(materialPages.ownerId, page.ownerId),
          eq(materialPages.ocrStatus, "queued"),
          sql`not ${liveJobListsPage}`,
        ),
      )
      .returning({ id: materialPages.id });
    if (updated.length === 0) continue;
    ended += 1;
    if (page.day !== null && /^\d{4}-\d{2}-\d{2}$/.test(page.day)) {
      await refundOcrPages(db, { ownerId: page.ownerId, day: page.day, pages: 1, now });
    }
  }
  return ended;
}
