// Scoring (decision 5), pure and safe on the client: the editor shows the live total with the same
// rules the server approves with. All arithmetic is in whole hundredths of a point, so a total of
// "exactly 100" is an integer comparison (10000), never a floating-point one.

export const SCORING_MODES = ["equal", "manual", "normalised"] as const;
export type ScoringMode = (typeof SCORING_MODES)[number];

/** The most points one item may carry (well inside the numeric(6, 2) column). */
export const MAX_POINTS = 1000;

const FULL = 10000; // 100 points in hundredths

/** A point value as a whole number of hundredths. */
export const toHundredths = (value: number): number => Math.round(value * 100);
const fromHundredths = (hundredths: number): number => hundredths / 100;

/**
 * Hands out `FULL` in proportion to `weights` (whole numbers, total > 0) by the largest remainder
 * method: every share is first rounded down, then the hundredths left over go one each to the
 * largest remainders, the earlier item first on a tie. The shares sum to exactly `FULL`.
 */
function largestRemainder(weights: number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  // Callers keep total * FULL a safe integer (normalise checks it), so the products are exact.
  const shares = weights.map((weight) => Math.floor((weight * FULL) / total));
  const remainders = weights.map((weight, index) => ({
    index,
    rest: weight * FULL - shares[index] * total,
  }));
  let left = FULL - shares.reduce((sum, share) => sum + share, 0);
  remainders.sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (const { index } of remainders) {
    if (left === 0) break;
    shares[index] += 1;
    left -= 1;
  }
  return shares;
}

/**
 * 100 points split equally over `n` items, two decimals each, summing to exactly 100: the first
 * items take the extra hundredths (3 items: 33.34, 33.33, 33.33). No items, no points.
 */
export function allocateEqual(n: number): number[] {
  if (!Number.isInteger(n) || n < 0) throw new RangeError("count must be a whole number");
  if (n === 0) return [];
  return largestRemainder(Array.from({ length: n }, () => 1)).map(fromHundredths);
}

/**
 * The teacher's points scaled to a total of 100, two decimals each, summing to exactly 100 (largest
 * remainder). Inputs are rounded to hundredths first; an item with zero points stays at zero. A
 * negative or non-finite point, or a zero total, is refused (RangeError): there is nothing to scale.
 */
export function normalise(points: number[]): number[] {
  if (points.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new RangeError("points must be finite and not negative");
  }
  const weights = points.map(toHundredths);
  if (weights.every((weight) => weight === 0)) {
    throw new RangeError("points must not total zero");
  }
  // The shares are exact only while weight * 10000 stays a safe integer.
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!Number.isSafeInteger(total * FULL)) {
    throw new RangeError("points are too large to scale exactly");
  }
  return largestRemainder(weights).map(fromHundredths);
}

/**
 * The points each item carries under a mode, given the stored points in outline order. `equal`
 * ignores the stored points; `manual` keeps them; `normalised` scales them, and is null when
 * nothing has points yet (no total to scale).
 */
export function scorePoints(mode: ScoringMode, stored: number[]): number[] | null {
  switch (mode) {
    case "equal":
      return allocateEqual(stored.length);
    case "manual":
      return stored.map((value) => fromHundredths(toHundredths(value)));
    case "normalised":
      if (stored.length === 0) return [];
      return stored.some((value) => toHundredths(value) > 0) ? normalise(stored) : null;
  }
}

/** The sum of points, computed in hundredths (so 33.34 + 33.33 + 33.33 is exactly 100). */
export const totalPoints = (points: number[]): number =>
  fromHundredths(points.reduce((sum, value) => sum + toHundredths(value), 0));

const POINTS_TEXT = /^\d{1,4}(?:[.,]\d{1,2})?$/;

/**
 * A point value the teacher typed or sent: positive, in steps of 0.01, at most `MAX_POINTS`. A
 * decimal comma is accepted. Anything else is null.
 */
export function parsePoints(value: unknown): number | null {
  let hundredths: number;
  if (typeof value === "string") {
    const text = value.trim();
    if (!POINTS_TEXT.test(text)) return null;
    hundredths = toHundredths(Number(text.replace(",", ".")));
  } else if (typeof value === "number" && Number.isFinite(value)) {
    hundredths = toHundredths(value);
    if (Math.abs(value * 100 - hundredths) > 1e-6) return null;
  } else {
    return null;
  }
  if (hundredths <= 0 || hundredths > MAX_POINTS * 100) return null;
  return fromHundredths(hundredths);
}
