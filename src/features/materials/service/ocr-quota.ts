import "server-only";
// The per-teacher OCR cap (decision 5): USER_DAILY_OCR_PAGES pages per Asia/Jakarta day, stored in
// ocr_usage (one row per owner and day). Pages are counted when they are QUEUED (reserved), so a
// retried job never counts a page twice; a page that ends without a model call (its image was
// missing, refused or blank, or its job failed for good) is given back. The trash ends a
// material's queued pages without a refund (R20 ruling: no AI was spent, the loss is the day's
// cap). Writes run on the service connection with an explicit owner filter: the teacher only
// reads ocr_usage.
import { and, count, eq, gte, inArray, or, sql } from "drizzle-orm";
import { aiCalls, jobs, ocrUsage } from "@/lib/db/schema";
import { err, ok, type Result } from "@/lib/result";
import { jakartaDayWindow } from "@/features/generation";
import { USER_DAILY_OCR_PAGES, USER_DAILY_VISION_READS } from "../schema/ocr";
import type { MaterialDb } from "./upload";

const JAKARTA_OFFSET_MS = 7 * 3_600_000;

/** The Asia/Jakarta calendar date of `now` as `YYYY-MM-DD` (the ocr_usage.day value). */
export function jakartaDay(now: Date): string {
  const start = jakartaDayWindow(now).start.getTime() + JAKARTA_OFFSET_MS;
  return new Date(start).toISOString().slice(0, 10);
}

/**
 * Serialises every change to one owner's vision count: OCR queueing here, and the solver's photo
 * reads (R28), which take this same lock after their own.
 */
export function lockOcrOwner(tx: MaterialDb, ownerId: string) {
  return tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`ocr_usage:${ownerId}`}, 0))`,
  );
}

async function usedOn(db: MaterialDb, ownerId: string, day: string): Promise<number> {
  const row = (
    await db
      .select({ pages: ocrUsage.pages })
      .from(ocrUsage)
      .where(and(eq(ocrUsage.ownerId, ownerId), eq(ocrUsage.day, day)))
  ).at(0);
  return row?.pages ?? 0;
}

/** The solver's photo-reading jobs (solver/schema/solver.ts EXTRACT_PROBLEM_JOB). */
const PHOTO_READ_JOB = "extract_problem";
const LIVE = ["queued", "running", "deferred"];

/**
 * Photo reads the owner started today: an extract_problem job counts while it is live and once
 * its call reached the model (a settled ai_calls row; a provisional `reserved` row of a run that
 * died before the call does not count). Ruling R28.
 */
async function photoReadsToday(
  db: MaterialDb,
  ownerId: string,
  now: Date,
): Promise<number> {
  const reached = sql`exists (select 1 from ${aiCalls}
    where ${aiCalls.jobId} = ${jobs.id} and ${aiCalls.ownerId} = ${jobs.ownerId}
      and ${aiCalls.errorCode} is distinct from 'reserved')`;
  const [row] = await db
    .select({ n: count() })
    .from(jobs)
    .where(
      and(
        eq(jobs.ownerId, ownerId),
        eq(jobs.type, PHOTO_READ_JOB),
        gte(jobs.createdAt, jakartaDayWindow(now).start),
        or(inArray(jobs.status, LIVE), reached),
      ),
    );
  return row.n;
}

/** Vision calls the owner started today: OCR pages and photo reads together (R28). */
export async function visionReadsToday(
  db: MaterialDb,
  ownerId: string,
  now: Date,
): Promise<number> {
  return (
    (await usedOn(db, ownerId, jakartaDay(now))) +
    (await photoReadsToday(db, ownerId, now))
  );
}

/** Vision reads the owner has left today ("x of 25 picture reads left"), never below 0. */
export async function visionReadsLeft(
  db: MaterialDb,
  input: { ownerId: string; now: Date },
): Promise<number> {
  return Math.max(
    0,
    USER_DAILY_VISION_READS - (await visionReadsToday(db, input.ownerId, input.now)),
  );
}

/** Pages the owner may still send to OCR today: the OCR sub-cap within the vision cap. */
export async function ocrPagesLeft(
  db: MaterialDb,
  input: { ownerId: string; now: Date },
): Promise<number> {
  const used = await usedOn(db, input.ownerId, jakartaDay(input.now));
  return Math.min(
    Math.max(0, USER_DAILY_OCR_PAGES - used),
    await visionReadsLeft(db, input),
  );
}

/**
 * Counts `pages` more pages for today, or refuses with `limit` (nothing counted) when they do not
 * fit in what is left. Call inside a transaction that already holds lockOcrOwner: the check and
 * the increment are then atomic for the owner. Returns the pages left after this reservation.
 */
export async function reserveOcrPages(
  tx: MaterialDb,
  input: { ownerId: string; pages: number; now: Date },
): Promise<Result<{ left: number; day: string }, "limit">> {
  const { ownerId, pages, now } = input;
  const day = jakartaDay(now);
  const used = await usedOn(tx, ownerId, day);
  const vision = used + (await photoReadsToday(tx, ownerId, now));
  if (
    pages < 1 ||
    used + pages > USER_DAILY_OCR_PAGES ||
    vision + pages > USER_DAILY_VISION_READS
  ) {
    return err("limit");
  }
  await tx
    .insert(ocrUsage)
    .values({ ownerId, day, pages, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [ocrUsage.ownerId, ocrUsage.day],
      set: { pages: sql`${ocrUsage.pages} + ${pages}`, updatedAt: now },
    });
  return ok({
    left: Math.min(
      USER_DAILY_OCR_PAGES - used - pages,
      USER_DAILY_VISION_READS - vision - pages,
    ),
    day,
  });
}

/**
 * Gives back `pages` reserved on `day` (the day they were queued), never below zero. One
 * statement: safe without the owner's lock.
 */
export async function refundOcrPages(
  db: MaterialDb,
  input: { ownerId: string; day: string; pages: number; now: Date },
): Promise<void> {
  if (input.pages < 1) return;
  await db
    .update(ocrUsage)
    .set({
      pages: sql`greatest(${ocrUsage.pages} - ${input.pages}, 0)`,
      updatedAt: input.now,
    })
    .where(and(eq(ocrUsage.ownerId, input.ownerId), eq(ocrUsage.day, input.day)));
}
