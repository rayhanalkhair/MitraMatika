import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import { eq } from "drizzle-orm";
import { verification } from "@/lib/db/schema";
import { forgetEvent, recordEvent } from "./attempt-counter";
import type { SendPurpose } from "./send-limit";

// Every account email of the whole app counts against one budget per Asia/Jakarta day, so one
// client (sign-ups to many invented addresses) cannot use up the email provider's quota and leave
// every teacher without a verification or reset email (ADR-0003: stop before a quota runs out).
// The last RESET_EMAIL_RESERVE of the day are kept for reset emails: a flood of sign-ups stops at
// AUTH_EMAILS_PER_DAY - RESET_EMAIL_RESERVE and resets still go out.
// The numbers sit below Resend's free tier as the research notes give it (100 emails per day);
// the real limit of the account must be verified at setup and these lowered if it is smaller.
export const AUTH_EMAILS_PER_DAY = 80;
export const RESET_EMAIL_RESERVE = 20;

const LABEL = "auth-email-day";
const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;

/** The Asia/Jakarta day of `at` (UTC+7, no daylight saving) and the instant it ends. */
export function jakartaDay(at: Date): { key: string; end: Date } {
  const local = new Date(at.getTime() + JAKARTA_OFFSET_MS);
  const nextMidnightLocal = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + 1,
  );
  return {
    key: local.toISOString().slice(0, 10),
    end: new Date(nextMidnightLocal - JAKARTA_OFFSET_MS),
  };
}

// A reservation counts at once but lives only this long until the email is confirmed as sent, so
// a background task that dies between the two (a crash, a killed function) gives its slot back on
// its own.
export const RESERVATION_HOLD_SECONDS = 5 * 60;

export interface Reservation {
  id: string;
  /** The end of the Jakarta day the reservation counts against. */
  dayEnd: Date;
}

export interface GlobalSendBudget {
  /**
   * Takes one email of this kind from today's budget, or answers null when the budget for this
   * kind is used up (nothing recorded). Rejects on a database error.
   */
  reserve(purpose: SendPurpose): Promise<Reservation | null>;
  /** The email went out: the reservation counts until the end of its day. */
  confirm(reservation: Reservation): Promise<void>;
  /** The email was not sent after all: the reservation is given back. */
  release(reservation: Reservation): Promise<void>;
}

/**
 * The day's count lives in Better Auth's `verification` table like the other limits: one row per
 * email under `auth-email-day:<yyyy-mm-dd>`. A reservation row expires after
 * RESERVATION_HOLD_SECONDS; confirming it moves the expiry to the end of the day, releasing it
 * deletes it. A refused reservation deletes its own row again, so refusals never use up the
 * budget. Two sends at the edge can both be refused (fail closed).
 * Accepted edges (re-review N4, ruled): (a) a send slower than the hold whose row another
 * reservation's expired-row cleanup already deleted is confirmed against no row, so that email
 * goes uncounted (Resend's own 10 s timeout makes this practically unreachable); (b) every
 * reservation counts while it is in flight, so near the 60 and 80 limits concurrent refused
 * attempts can briefly refuse an email that would have fitted, and the error log then says the
 * budget is used up although it was only momentarily full. Other kinds stop at
 * AUTH_EMAILS_PER_DAY - RESET_EMAIL_RESERVE, so they can never take the reserve.
 */
export function createGlobalSendBudget<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: PgAsyncDatabase<TQueryResult, TRelations>,
  now: () => Date = () => new Date(),
): GlobalSendBudget {
  return {
    async reserve(purpose) {
      const at = now();
      const day = jakartaDay(at);
      const hold = new Date(
        Math.min(at.getTime() + RESERVATION_HOLD_SECONDS * 1000, day.end.getTime()),
      );
      const { id, live } = await recordEvent(db, `${LABEL}:${day.key}`, at, hold);
      const max =
        purpose === "reset"
          ? AUTH_EMAILS_PER_DAY
          : AUTH_EMAILS_PER_DAY - RESET_EMAIL_RESERVE;
      if (live <= max) return { id, dayEnd: day.end };
      await forgetEvent(db, id);
      return null;
    },
    async confirm(reservation) {
      await db
        .update(verification)
        .set({ expiresAt: reservation.dayEnd })
        .where(eq(verification.id, reservation.id));
    },
    release: (reservation) => forgetEvent(db, reservation.id),
  };
}
