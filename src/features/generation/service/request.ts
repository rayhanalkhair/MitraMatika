import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import { generationRequests, jobs } from "@/lib/db/schema";
import { createJobQueue } from "@/lib/jobs/queue";
import { err, ok, type Result } from "@/lib/result";
import type { MaterialSelection } from "../schema/material-selection";
import {
  resolveMaterialSelection,
  type MaterialSelectionError,
} from "./material-selection";
import { buildMaterialContext } from "./material-context";
import { materialContextBudget } from "./prompts/generate-mc.id";
import {
  estimateBatchTokens,
  GENERATE_QUOTA,
  jakartaDayWindow,
  planQuota,
  questionsRequestedToday,
  readRecentSpends,
  USER_DAILY_QUESTION_LIMIT,
} from "./quota";

export type GenerationDifficulty = "mudah" | "sedang" | "sulit";

export interface CreateRequestInput {
  ownerId: string;
  topic: { id: string; stableKey: string; title: string };
  curriculumVersionId: string;
  quantity: number;
  difficulty: GenerationDifficulty;
  // Material mode: the material and the part of it the questions are written from.
  material?: MaterialSelection;
  now: Date;
}

export type CreateRequestResult = Result<
  { requestId: string; jobId: string; deferredUntil: Date | null },
  | { reason: "active_request"; requestId: string }
  | {
      reason: "daily_limit";
      limit: number;
      used: number;
      remaining: number;
      resetsAt: Date;
    }
  // `unrelated`: no chosen page matches the topic.
  | { reason: "material"; error: MaterialSelectionError | "unrelated" }
>;

const ACTIVE_STATUSES = ["queued", "running", "deferred"];

// The form allows 1 to 5 questions per request; the service refuses anything else itself, so no
// caller can spend the daily limit or the AI budget in one oversized request.
export const MIN_REQUEST_QUANTITY = 1;
export const MAX_REQUEST_QUANTITY = 5;

/**
 * Creates a generation request and its job in one transaction. An advisory lock serialises one
 * teacher's submissions, so the "one active request" check cannot be raced: a second call returns
 * `err({ reason: "active_request", requestId })`. A teacher may request at most
 * USER_DAILY_QUESTION_LIMIT questions per Asia/Jakarta day; past that the call returns
 * `err({ reason: "daily_limit", ... })`, counted under the same lock. A request that does not fit the daily quota is
 * created `deferred` with `deferredUntil` set. Service connection: filters by `ownerId` itself.
 */
export async function createGenerationRequest<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: PgAsyncDatabase<TQueryResult, TRelations>,
  input: CreateRequestInput,
): Promise<CreateRequestResult> {
  if (
    !Number.isInteger(input.quantity) ||
    input.quantity < MIN_REQUEST_QUANTITY ||
    input.quantity > MAX_REQUEST_QUANTITY
  ) {
    throw new RangeError(
      `quantity must be an integer from ${String(MIN_REQUEST_QUANTITY)} to ${String(MAX_REQUEST_QUANTITY)}`,
    );
  }
  return db.transaction(async (tx) => {
    // Relies on READ COMMITTED (each later statement takes a fresh snapshot after the lock wait), so
    // do not raise the isolation level.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`generation_request:${input.ownerId}`}, 0))`,
    );

    const active = (
      await tx
        .select({ id: generationRequests.id })
        .from(generationRequests)
        // The linked job's status is the source of truth: the queue maintains it. The generate_batch
        // handler syncs the request's own status best effort (P1-10), but a crashed or killed run
        // cannot, so a request status alone could lock a teacher out after a failed or finished job.
        .innerJoin(
          jobs,
          and(
            eq(jobs.id, generationRequests.jobId),
            eq(jobs.ownerId, generationRequests.ownerId),
          ),
        )
        .where(
          and(
            eq(generationRequests.ownerId, input.ownerId),
            inArray(generationRequests.status, ACTIVE_STATUSES),
            inArray(jobs.status, ACTIVE_STATUSES),
          ),
        )
        .limit(1)
    ).at(0);
    if (active) return err({ reason: "active_request", requestId: active.id } as const);

    // The material must be this teacher's, not in the trash, ingested, and every chosen page or
    // chapter readable (checked again whenever the job reads it).
    if (input.material) {
      const resolved = await resolveMaterialSelection(tx, {
        ownerId: input.ownerId,
        selection: input.material,
      });
      if (!resolved.ok)
        return err({ reason: "material", error: resolved.error } as const);
      // At least one chosen page must match the topic, or the questions would not come from it.
      const context = await buildMaterialContext(tx, {
        ownerId: input.ownerId,
        materialId: input.material.materialId,
        selection: input.material,
        topicId: input.topic.id,
      });
      if (context.unrelated)
        return err({ reason: "material", error: "unrelated" } as const);
    }

    const used = await questionsRequestedToday(tx, input.ownerId, input.now);
    if (used + input.quantity > USER_DAILY_QUESTION_LIMIT) {
      return err({
        reason: "daily_limit",
        limit: USER_DAILY_QUESTION_LIMIT,
        used,
        remaining: Math.max(0, USER_DAILY_QUESTION_LIMIT - used),
        resetsAt: jakartaDayWindow(input.now).end,
      } as const);
    }

    const spends = await readRecentSpends(tx, GENERATE_QUOTA.model, input.now);
    const plan = planQuota({
      spends,
      // A material request also carries up to its context budget of material (the page text may
      // still change before the job runs, so the budget, not today's text).
      estimate:
        estimateBatchTokens(input.quantity) +
        (input.material ? materialContextBudget(input.quantity) : 0),
      perDay: GENERATE_QUOTA.perDay,
      now: input.now,
    });
    const deferredUntil = plan.ok ? null : plan.error.resumeAt;
    const status = deferredUntil ? "deferred" : "queued";

    const [request] = await tx
      .insert(generationRequests)
      .values({
        ownerId: input.ownerId,
        mode: input.material ? "material" : "topic",
        sourceSelection: input.material ?? null,
        inputKind: "form",
        status,
        params: {
          grade: 8,
          topicId: input.topic.id,
          topicStableKey: input.topic.stableKey,
          topicTitle: input.topic.title,
          curriculumVersionId: input.curriculumVersionId,
          type: "multiple_choice",
          quantity: input.quantity,
          difficulty: input.difficulty,
        },
        // The daily count reads createdAt against `now`, so the row carries the same clock.
        createdAt: input.now,
      })
      .returning({ id: generationRequests.id });

    // The job payload only names the request. The P1-10 handler must load the request and check
    // request.ownerId === job.ownerId and request.jobId === job.id before trusting its params.
    const job = await createJobQueue(tx, () => input.now).enqueue({
      ownerId: input.ownerId,
      type: "generate_batch",
      payload: { requestId: request.id },
      status,
      runAfter: deferredUntil ?? input.now,
    });

    await tx
      .update(generationRequests)
      .set({ jobId: job.id, updatedAt: input.now })
      .where(eq(generationRequests.id, request.id));

    return ok({ requestId: request.id, jobId: job.id, deferredUntil });
  });
}
