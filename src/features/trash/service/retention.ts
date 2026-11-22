// Shared by every entity the trash holds: how long a row stays, and the "still in use" refusal.
export const TRASH_RETENTION_DAYS = 30;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** When a row trashed at `now` is purged: now + 30 days. */
export function purgeAfterFrom(now: Date): Date {
  return new Date(now.getTime() + TRASH_RETENTION_DAYS * DAY_MS);
}

/** Whole days until the purge, never below 0 (0 = goes at the next daily purge). */
export function daysLeft(purgeAfter: Date, now: Date): number {
  return Math.max(0, Math.ceil((purgeAfter.getTime() - now.getTime()) / DAY_MS));
}

/** Unknown or another teacher's (or, for a trash, already trashed); not in the trash. */
export type TrashFailure = "notFound" | "notInTrash";

/**
 * A permanent delete refused because something still uses the row (R2): the titles of the
 * assessments that pin the question or print with the template, for the teacher's message.
 */
export interface InUse {
  code: "inUse";
  assessments: string[];
}
