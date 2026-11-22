import "server-only";
// Job `extract_problem` (decision 10): the vision model reads the problem from the session's photo.
// The vision model is shared with OCR and paced the same way: its output-per-minute budget (1,000
// tokens; a call reserves 900) and its day budget are read from ai_calls across every run, and the
// call is booked there first, dated at the minute slot it will use, under the model's advisory
// lock (Ruling R19 provisional rows; the lock OCR pages take too). The photo is checked again
// (own key, raw size before base64, PNG/JPEG magic) before it is sent.
//
// The answer is Markdown with `[[?]]` around unsure parts (R14). When the reading has any marker,
// a formula KaTeX cannot parse, was cut at the output cap or is empty, the session waits for the
// teacher's confirmation (SOL-02) and nothing is solved; otherwise the reading becomes the
// confirmed problem and the solve is queued (part of the photo's run: not counted again).
// A trashed session, one already read, or a retried run after the write are left alone.
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  AiImageError,
  AiOutputError,
  AiPolicyError,
  AiProviderError,
  AiQuotaError,
  defaultRouting,
  type AiImage,
  type AiUsage,
  type TokenBudget,
} from "@/lib/ai";
import { MAX_OUTPUT_WAIT_MS } from "@/lib/ai/budget";
import { aiCalls, solverSessions } from "@/lib/db/schema";
import {
  PermanentJobError,
  RetryableJobError,
  type HandlerResult,
  type JobHandler,
} from "@/lib/jobs/handler";
import { createJobQueue } from "@/lib/jobs/queue";
import { logger } from "@/lib/logger";
import type { ObjectStore } from "@/lib/storage/types";
import {
  aiErrorCode,
  lockWaitMs,
  pgCodeOf,
  planQuota,
  providerRetryDelayMs,
  QUOTA_RETRY_MS,
  type Gateway,
} from "@/features/generation";
import {
  OCR_MAX_OUTPUT_TOKENS,
  OCR_QUOTA,
  readVisionSpends,
  teacherVisionPlan,
  VISION_RESERVED,
  visionBudget,
  type VisionSpend,
} from "@/features/materials";
import { extractionAnswerSchema } from "../schema/answers";
import {
  MAX_SOLVER_PHOTO_BYTES,
  SOLVE_PROBLEM_JOB,
  type ExtractionFlag,
} from "../schema/solver";
import { extractionFlags } from "./issues";
import { mimeOfExt, parseSessionKey } from "./keys";
import {
  buildExtractProblemPrompt,
  EXTRACT_PROBLEM_PROMPT_VERSION,
} from "./prompts/extract-problem.id";
import { neverSent, type SolverDb } from "./quota";

const TASK = "ocr_page";
const ROUTE = defaultRouting.ocr_page[0];
if (ROUTE.otpm === undefined) throw new Error("ocr_page: the vision route must be paced");
const OTPM = ROUTE.otpm;
/** About one photo: the prompt, one image (2,048 tokens) and the reserved output. */
const PHOTO_ESTIMATE_TOKENS = 3_300;
/** A model call (30 s timeout) and the writes after it. */
const CALL_BUDGET_MS = 35_000;
const SOLVE_MAX_ATTEMPTS = 3;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

export interface ExtractedProblem {
  markdown: string;
  flags: ExtractionFlag[];
}

/**
 * Reads the problem in one image with the vision model (task ocr_page, C2, at most 900 output
 * tokens) and says why the reading must be confirmed, if it must.
 */
export async function extractProblem(
  deps: { gateway: Gateway; deadline?: number; onUsage?: (usage: AiUsage) => void },
  input: { image: AiImage },
): Promise<ExtractedProblem> {
  const { system, prompt } = buildExtractProblemPrompt();
  let truncated = false;
  const result = await deps.gateway.generate({
    task: TASK,
    dataClass: "C2",
    system,
    prompt,
    images: [input.image],
    maxOutputTokens: OCR_MAX_OUTPUT_TOKENS,
    deadline: deps.deadline,
    onUsage: (usage) => {
      truncated = usage.outputTokens >= OCR_MAX_OUTPUT_TOKENS;
      deps.onUsage?.(usage);
    },
    parse: (raw) => extractionAnswerSchema.parse(raw),
  });
  const markdown = result.value.markdown.replace(/\r\n?/g, "\n").trim();
  return { markdown, flags: extractionFlags(markdown, { truncated }) };
}

export interface ExtractProblemDeps {
  db: SolverDb;
  store: ObjectStore;
  createGateway: (budget: TokenBudget) => Gateway;
  now?: () => Date;
  /** The budget's wait for the output slot (tests pass a fake clock's sleep). */
  sleep?: (ms: number) => Promise<void>;
  /** False only with the e2e fake AI (its answers spend nothing): no output pacing. */
  paced?: boolean;
}

const payloadSchema = z.object({ sessionId: z.uuid() });
const SKIPPED: HandlerResult = {
  kind: "done",
  progress: { step: "skipped", done: 0, total: 0 },
};
const MESSAGES = {
  extract_invalid: "The photo reading job payload is not valid.",
  extract_not_found: "The session of the photo reading job was not found.",
  extract_invalid_output: "The AI answer did not match the reading format.",
  extract_blocked: "The photo cannot be sent to the AI.",
  provider_unavailable: "The AI service is not available; it will be retried.",
} as const;

const startsWith = (bytes: Uint8Array, signature: number[]) =>
  signature.every((byte, i) => bytes[i] === byte);

type Booking =
  | { kind: "gone" }
  | { kind: "later"; at: Date }
  | { kind: "booked"; spends: VisionSpend[]; reservationId: string };

export function createExtractProblemHandler(deps: ExtractProblemDeps): JobHandler {
  const { db, store } = deps;
  const clock = deps.now ?? (() => new Date());
  const paced = deps.paced ?? true;

  return async (ctx) => {
    const parsed = payloadSchema.safeParse(ctx.job.payload);
    if (!parsed.success) {
      throw new PermanentJobError("extract_invalid", MESSAGES.extract_invalid);
    }
    const { sessionId } = parsed.data;
    const { ownerId } = ctx;
    const ofSession = and(
      eq(solverSessions.id, sessionId),
      eq(solverSessions.ownerId, ownerId),
    );
    const waiting = and(
      ofSession,
      isNull(solverSessions.deletedAt),
      eq(solverSessions.status, "extracting"),
    );
    const session = (
      await db
        .select({
          status: solverSessions.status,
          inputKey: solverSessions.inputKey,
          deletedAt: solverSessions.deletedAt,
        })
        .from(solverSessions)
        .where(ofSession)
        .limit(1)
    ).at(0);
    if (!session) {
      throw new PermanentJobError("extract_not_found", MESSAGES.extract_not_found);
    }
    if (session.deletedAt || session.status !== "extracting") return SKIPPED;

    /** The reading cannot happen: the teacher may type the problem instead. */
    const failSession = () =>
      db
        .update(solverSessions)
        .set({ status: "failed", updatedAt: clock() })
        .where(waiting);

    // The photo: own final key only, raw size first, then the magic bytes of its type.
    const key = parseSessionKey(ownerId, sessionId, session.inputKey);
    const bytes =
      key?.stage === "photo" && session.inputKey
        ? await store.get(session.inputKey)
        : null;
    const mime = key ? mimeOfExt(key.ext) : null;
    if (
      !bytes ||
      !mime ||
      bytes.length > MAX_SOLVER_PHOTO_BYTES ||
      !startsWith(bytes, mime === "image/png" ? PNG_SIGNATURE : JPEG_SIGNATURE)
    ) {
      logger.warn(
        { module: "solver", jobId: ctx.job.id, code: "image_invalid" },
        "solver: photo refused",
      );
      await failSession();
      return { kind: "done", progress: { step: "image_refused", done: 0, total: 1 } };
    }

    // 1. Book the vision call under the model's lock (every OCR and photo run takes it).
    let booked: Booking;
    try {
      booked = await db.transaction(async (rawTx): Promise<Booking> => {
        const tx = rawTx as unknown as SolverDb;
        const waitMs = lockWaitMs(ctx.deadline, clock().getTime());
        await tx.execute(sql.raw(`set local lock_timeout = '${String(waitMs)}ms'`));
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`ai:${ROUTE.model}`}, 0))`,
        );
        await tx.execute(sql.raw("set local lock_timeout = 0"));
        const live = await tx
          .select({ id: solverSessions.id })
          .from(solverSessions)
          .where(waiting)
          .for("share");
        if (live.length === 0) return { kind: "gone" };
        const now = clock();
        const spends = await readVisionSpends(tx, now);
        const plan = planQuota({
          spends: spends.map((spend) => ({
            at: spend.at,
            tokens: spend.input + spend.output,
          })),
          estimate: PHOTO_ESTIMATE_TOKENS,
          perDay: OCR_QUOTA.perDay,
          now,
        });
        if (!plan.ok) return { kind: "later", at: plan.error.resumeAt };
        // R28: no teacher takes more than a quarter of the vision model's day.
        const mine = await teacherVisionPlan(tx, {
          ownerId,
          estimate: PHOTO_ESTIMATE_TOKENS,
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
        const [reservation] = await tx
          .insert(aiCalls)
          .values({
            ownerId,
            jobId: ctx.job.id,
            task: TASK,
            provider: ROUTE.provider,
            model: ROUTE.model,
            promptVersion: EXTRACT_PROBLEM_PROMPT_VERSION,
            inputTokens: PHOTO_ESTIMATE_TOKENS - OCR_MAX_OUTPUT_TOKENS,
            outputTokens: OCR_MAX_OUTPUT_TOKENS,
            outcome: "error",
            errorCode: VISION_RESERVED,
            createdAt: new Date(slot),
          })
          .returning({ id: aiCalls.id });
        return { kind: "booked", spends, reservationId: reservation.id };
      });
    } catch (error) {
      if (pgCodeOf(error) === "55P03") {
        return { kind: "defer", runAfter: new Date(ctx.deadline) };
      }
      throw error;
    }
    if (booked.kind === "gone") return SKIPPED;
    if (booked.kind === "later") return { kind: "defer", runAfter: booked.at };

    // 2. The vision call, outside any transaction.
    const spent: AiUsage = { inputTokens: 0, outputTokens: 0 };
    const startedAt = clock().getTime();
    const ours = and(
      eq(aiCalls.id, booked.reservationId),
      eq(aiCalls.errorCode, VISION_RESERVED),
    );
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
    let reading: ExtractedProblem;
    try {
      reading = await extractProblem(
        {
          gateway: deps.createGateway(
            visionBudget(booked.spends, () => clock().getTime(), deps.sleep),
          ),
          deadline: ctx.deadline - CALL_BUDGET_MS,
          onUsage: (usage) => {
            spent.inputTokens += usage.inputTokens;
            spent.outputTokens += usage.outputTokens;
          },
        },
        { image: { mime, base64: Buffer.from(bytes).toString("base64") } },
      );
    } catch (error) {
      // Refused before anything was sent: no call, so no spend and no run to count (D1).
      if (neverSent(error, spent)) await db.delete(aiCalls).where(ours);
      else await settle("error", aiErrorCode(error));
      if (error instanceof AiQuotaError) {
        return { kind: "defer", runAfter: new Date(clock().getTime() + QUOTA_RETRY_MS) };
      }
      if (error instanceof AiProviderError && error.kind === "rate_limited") {
        return {
          kind: "defer",
          runAfter: new Date(
            clock().getTime() + providerRetryDelayMs(error.retryAfterMs),
          ),
        };
      }
      if (error instanceof AiImageError) {
        await failSession();
        return { kind: "done", progress: { step: "image_refused", done: 0, total: 1 } };
      }
      let thrown: Error;
      if (error instanceof AiOutputError) {
        thrown = new PermanentJobError(
          "extract_invalid_output",
          MESSAGES.extract_invalid_output,
        );
      } else if (error instanceof AiPolicyError) {
        thrown = new PermanentJobError("extract_blocked", MESSAGES.extract_blocked);
      } else {
        thrown = new RetryableJobError(
          "provider_unavailable",
          MESSAGES.provider_unavailable,
        );
      }
      if (
        thrown instanceof PermanentJobError ||
        ctx.job.attempts + 1 >= ctx.job.maxAttempts
      ) {
        await failSession();
      }
      throw thrown;
    }
    await settle("ok", null);

    // 3. The reading, under the session's row lock while it still waits for it.
    const clear = reading.flags.length === 0;
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as SolverDb;
      const now = clock();
      const updated = await tx
        .update(solverSessions)
        .set({
          extractedMd: reading.markdown,
          extractionFlags: reading.flags,
          confirmedMd: clear ? reading.markdown : null,
          status: clear ? "ready" : "needs_confirmation",
          updatedAt: now,
        })
        .where(waiting)
        .returning({ id: solverSessions.id });
      if (updated.length === 0 || !clear) return;
      await createJobQueue(tx, () => now).enqueue({
        ownerId,
        type: SOLVE_PROBLEM_JOB,
        payload: { sessionId, after: 0, counted: false },
        createdAt: now,
        runAfter: now,
        maxAttempts: SOLVE_MAX_ATTEMPTS,
      });
    });
    return { kind: "done", progress: { step: "done", done: 1, total: 1 } };
  };
}
