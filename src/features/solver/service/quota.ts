// The per-teacher daily cap (decision 11): USER_DAILY_SOLVES model runs per Asia/Jakarta day,
// counted from the jobs table like the generation daily limit and the structure proposals: every
// `extract_problem` and `alternative_method` job and every `solve_problem` job queued as counted.
// Ruling D1 (like OCR R21): a run counts while it is queued, running or deferred, and once it has
// reached the model (an ai_calls row of the job); a run that ended without any model call (moved
// to the trash, a photo refused, refused before sending) is given back.
// The count runs under a per-owner advisory lock taken by the caller's transaction, so two
// requests at once cannot both take the last solve. Jobs are never deleted, so a session moved to
// the trash or purged still counts on the day it ran.
import { and, count, eq, exists, gte, inArray, or, sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import { aiCalls, jobs } from "@/lib/db/schema";
import { AiImageError, AiPolicyError, AiQuotaError } from "@/lib/ai";
import { jakartaDayWindow } from "@/features/generation";
import {
  ALTERNATIVE_METHOD_JOB,
  EXTRACT_PROBLEM_JOB,
  SOLVE_PROBLEM_JOB,
  USER_DAILY_SOLVES,
} from "../schema/solver";

export type SolverDb = PgAsyncDatabase<PgQueryResultHKT, AnyRelations>;

/** Serialises one teacher's solver requests (inside the caller's transaction). */
export async function lockSolverOwner(tx: SolverDb, ownerId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`solver:${ownerId}`}, 0))`,
  );
}

const LIVE = ["queued", "running", "deferred"];

/** A gateway refusal raised before any provider call (images, policy, budget). */
export function neverSent(
  error: unknown,
  spent: { inputTokens: number; outputTokens: number },
): boolean {
  return (
    spent.inputTokens === 0 &&
    spent.outputTokens === 0 &&
    (error instanceof AiQuotaError ||
      error instanceof AiPolicyError ||
      error instanceof AiImageError)
  );
}
// A settled ai_calls row of the job: a provisional `reserved` row whose run died before its call
// (or mid-call) does not count once the job is no longer live (D1, like OCR R21).
const reachedModel = exists(
  sql`(select 1 from ${aiCalls} where ${aiCalls.jobId} = ${jobs.id} and ${aiCalls.ownerId} = ${jobs.ownerId} and ${aiCalls.errorCode} is distinct from 'reserved')`,
);

/** Model runs the owner started since 00:00 Asia/Jakarta of `now`'s day. */
export async function solvesUsedToday(
  db: SolverDb,
  ownerId: string,
  now: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(jobs)
    .where(
      and(
        eq(jobs.ownerId, ownerId),
        gte(jobs.createdAt, jakartaDayWindow(now).start),
        or(
          inArray(jobs.type, [EXTRACT_PROBLEM_JOB, ALTERNATIVE_METHOD_JOB]),
          and(
            eq(jobs.type, SOLVE_PROBLEM_JOB),
            sql`coalesce((${jobs.payload}->>'counted')::boolean, true)`,
          ),
        ),
        or(inArray(jobs.status, LIVE), reachedModel),
      ),
    );
  return row.n;
}

/** Solves the owner has left today ("x of 30 left today"). */
export async function solvesLeft(
  db: SolverDb,
  input: { ownerId: string; now: Date },
): Promise<number> {
  return Math.max(
    0,
    USER_DAILY_SOLVES - (await solvesUsedToday(db, input.ownerId, input.now)),
  );
}

/**
 * Whether a photo reading of the session reached the model today (Asia/Jakarta): that run was
 * counted today and its solve is part of it. A reading of an earlier day was counted on that day,
 * so today's solve is a run of its own.
 */
export async function readingReachedModel(
  db: SolverDb,
  ownerId: string,
  sessionId: string,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .select({ id: aiCalls.id })
    .from(aiCalls)
    .innerJoin(jobs, and(eq(jobs.id, aiCalls.jobId), eq(jobs.ownerId, aiCalls.ownerId)))
    .where(
      and(
        eq(aiCalls.ownerId, ownerId),
        sql`${aiCalls.errorCode} is distinct from 'reserved'`,
        eq(jobs.type, EXTRACT_PROBLEM_JOB),
        gte(jobs.createdAt, jakartaDayWindow(now).start),
        sql`${jobs.payload}->>'sessionId' = ${sessionId}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}
