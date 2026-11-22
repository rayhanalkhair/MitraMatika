// Scoring mode, item points and the shuffle (decisions 4 and 5). Every write locks the assessment
// row first and is refused while it is approved (lock.ts). The caller applies `runAsUser`; each
// statement also names owner_id.
import "server-only";
import { randomInt } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { assessmentItems, assessments } from "@/lib/db/schema";
import { err, ok, type Result } from "@/lib/result";
import { MAX_ITEMS } from "./items";
import {
  isUuid,
  lockAssessment,
  touchAssessment,
  type AssessmentDb,
  type LockFailure,
} from "./lock";
import { parsePoints, toHundredths, type ScoringMode } from "./scoring";

interface Target {
  ownerId: string;
  assessmentId: string;
}

const where = ({ ownerId, assessmentId }: Target) =>
  and(eq(assessments.id, assessmentId), eq(assessments.ownerId, ownerId));

/** Equal, manual or normalised. The stored points stay as they are (the mode decides their use). */
export async function setScoringMode(
  tx: AssessmentDb,
  input: Target & { mode: ScoringMode },
): Promise<Result<void, LockFailure>> {
  const locked = await lockAssessment(tx, input);
  if (!locked.ok) return locked;
  await tx
    .update(assessments)
    .set({ scoringMode: input.mode, updatedAt: sql`now()` })
    .where(where(input));
  return ok();
}

export type PointsFailure = LockFailure | "invalid" | "invalidPoints" | "itemNotFound";

/**
 * The points of the named items (the teacher's own points: used as they are in manual mode and
 * scaled to 100 in normalised mode). Each must be positive, in steps of 0.01 and at most
 * MAX_POINTS; every item must belong to this assessment. All or nothing.
 */
export async function setPoints(
  tx: AssessmentDb,
  input: Target & { points: { itemId: string; points: number }[] },
): Promise<Result<{ changed: number }, PointsFailure>> {
  const parsed = input.points.map((entry) => ({
    itemId: entry.itemId,
    points: parsePoints(entry.points),
  }));
  const ids = new Set(parsed.map((entry) => entry.itemId));
  // A repeated item or an oversized list is a malformed request, not a bad value.
  if (parsed.length > MAX_ITEMS || ids.size !== parsed.length) return err("invalid");
  if (parsed.some((entry) => entry.points === null)) return err("invalidPoints");
  const locked = await lockAssessment(tx, input);
  if (!locked.ok) return locked;
  if (parsed.length === 0) return ok({ changed: 0 });
  if ([...ids].some((id) => !isUuid(id))) return err("itemNotFound");
  const found = await tx
    .select({ id: assessmentItems.id })
    .from(assessmentItems)
    .where(
      and(
        eq(assessmentItems.assessmentId, input.assessmentId),
        eq(assessmentItems.ownerId, input.ownerId),
        inArray(assessmentItems.id, [...ids]),
      ),
    );
  if (found.length !== ids.size) return err("itemNotFound");

  const rows = sql.join(
    parsed.map(
      (entry) =>
        sql`(${entry.itemId}::uuid, ${(toHundredths(entry.points ?? 0) / 100).toFixed(2)}::numeric)`,
    ),
    sql`, `,
  );
  await tx.execute(sql`
    update assessment_items as i
    set points = v.points, updated_at = now()
    from (values ${rows}) as v(id, points)
    where i.id = v.id
      and i.owner_id = ${input.ownerId}::uuid
      and i.assessment_id = ${input.assessmentId}::uuid
  `);
  await touchAssessment(tx, input);
  return ok({ changed: parsed.length });
}

/** A fresh seed, made on the server; never the one in use. */
function newSeed(current: number | null): number {
  let seed = randomInt(1, 2 ** 31 - 1);
  while (seed === current) seed = randomInt(1, 2 ** 31 - 1);
  return seed;
}

/**
 * `on` stores a server-made seed (keeping the one in use, if any); `reshuffle` always stores a new
 * one; `off` clears it. The order and numbering follow from the seed (shuffle.ts).
 */
export async function setShuffle(
  tx: AssessmentDb,
  input: Target & { mode: "on" | "off" | "reshuffle" },
): Promise<Result<{ seed: number | null }, LockFailure>> {
  const locked = await lockAssessment(tx, input);
  if (!locked.ok) return locked;
  const current =
    (
      await tx
        .select({ seed: assessments.shuffleSeed })
        .from(assessments)
        .where(where(input))
    ).at(0)?.seed ?? null;
  const seed =
    input.mode === "off"
      ? null
      : input.mode === "on" && current !== null
        ? current
        : newSeed(current);
  if (seed !== current) {
    await tx
      .update(assessments)
      .set({ shuffleSeed: seed, updatedAt: sql`now()` })
      .where(where(input));
  }
  return ok({ seed });
}
