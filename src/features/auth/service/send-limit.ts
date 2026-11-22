import { createHmac } from "node:crypto";
import { and, eq, gt, inArray, lte } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import { verification } from "@/lib/db/schema";
import { ipLimitSubject } from "./client-ip";

// Per address: at most 1 account email of each kind per minute (so a reset is not held back by a
// verification sent seconds earlier). Then each kind has budgets of its own (final review I2):
// - verification and reset emails each: 3 per hour per (address, client IP) pair and 20 per 24 h
//   per address. Reset no longer shares a budget with verification, and one client IP can spend
//   only its own 3 per hour of an address, so repeated requests from one network cannot block the
//   owner's own reset or verification email; it takes 7 networks a day to use up the 20.
// - account-exists emails, which anyone can trigger by signing up with an address that has an
//   account: 3 per hour per address on their own (ruling S5).
// The records live in Better Auth's own `verification` table (no schema change, no owner foreign
// key: the address may not belong to a user with a profile yet). Each allowed send writes one row
// per identifier (the cooldown and each budget), expiring at the end of its window, so "rows with
// expires_at in the future" are the cooldown and the sends of that window; expired rows are
// deleted on the next write. A refused send writes nothing. The subject is an HMAC-SHA-256 of the
// normalised address (with the IP for a pair budget) keyed by a per-label key derived from the
// auth secret: the plain address and IP are never stored or logged, a leaked table cannot be used
// to test guessed addresses, and the rows of two labels cannot be linked. The index on
// `identifier` serves the lookups. Two simultaneous requests can both pass the check (accepted;
// no unique index). Pair rows cannot be found again from the address alone, so account deletion
// leaves them to expire within the hour (they hold no address or user id).
export const SEND_COOLDOWN_SECONDS = 60;
export const SEND_WINDOW_SECONDS = 3600;
export const SEND_DAY_SECONDS = 24 * 3600;
export const SENDS_PER_PAIR_PER_HOUR = 3;
export const SENDS_PER_ADDRESS_PER_DAY = 20;
export const ACCOUNT_EXISTS_SENDS_PER_WINDOW = 3;
// Requests without a resolved client IP share one pair key (fail closed).
const NO_TRUSTED_IP = "no-trusted-ip";

/** The kinds of account email; each has its own cooldown and budgets. */
export type SendPurpose = "verify" | "reset" | "accountExists";

interface Budget {
  label: string;
  max: number;
  windowSeconds: number;
  /** Keyed by (address, client IP) instead of the address alone. */
  perPair: boolean;
}

const BUDGETS: Record<SendPurpose, Budget[]> = {
  verify: [
    {
      label: "verifyPairHourly",
      max: SENDS_PER_PAIR_PER_HOUR,
      windowSeconds: SEND_WINDOW_SECONDS,
      perPair: true,
    },
    {
      label: "verifyDaily",
      max: SENDS_PER_ADDRESS_PER_DAY,
      windowSeconds: SEND_DAY_SECONDS,
      perPair: false,
    },
  ],
  reset: [
    {
      label: "resetPairHourly",
      max: SENDS_PER_PAIR_PER_HOUR,
      windowSeconds: SEND_WINDOW_SECONDS,
      perPair: true,
    },
    {
      label: "resetDaily",
      max: SENDS_PER_ADDRESS_PER_DAY,
      windowSeconds: SEND_DAY_SECONDS,
      perPair: false,
    },
  ],
  accountExists: [
    {
      label: "accountExistsHourly",
      max: ACCOUNT_EXISTS_SENDS_PER_WINDOW,
      windowSeconds: SEND_WINDOW_SECONDS,
      perPair: false,
    },
  ],
};

export interface SendLimiter {
  /**
   * True when an email may go out now to `email`, requested from client `ip`; records the send.
   * Rejects on a database error.
   */
  allow(email: string, ip?: string): Promise<boolean>;
}

const normalise = (email: string) => email.trim().toLowerCase();

function identifierFor(secret: string, label: string) {
  // Domain separation: the HMAC key is derived from the auth secret with a per-label label, so the
  // raw secret is never used directly as a key for this purpose.
  const key = createHmac("sha256", secret)
    .update(`mitramatika:email-sent:${label}:v1`)
    .digest();
  return (subject: string) =>
    `email-sent:${label}:` + createHmac("sha256", key).update(subject).digest("hex");
}

/**
 * Every `verification` identifier the limiter can write for `email` alone (each kind's cooldown
 * and every per-address budget), built the same way. Account deletion deletes exactly these rows.
 */
export function sendLimitIdentifiers(secret: string, email: string): string[] {
  const labels = new Set<string>([
    ...(Object.keys(BUDGETS) as SendPurpose[]),
    ...Object.values(BUDGETS)
      .flat()
      .filter((budget) => !budget.perPair)
      .map((budget) => budget.label),
  ]);
  return [...labels].map((label) => identifierFor(secret, label)(normalise(email)));
}

/** The per-pair hourly identifier of `purpose` for `email` requested from `ip` (tests, runbook). */
export function sendLimitPairIdentifier(
  secret: string,
  purpose: "verify" | "reset",
  email: string,
  ip: string | undefined,
): string {
  return identifierFor(secret, `${purpose}PairHourly`)(pairSubject(normalise(email), ip));
}

// IPv6 by its /64 (client-ip.ts), so one host cannot rotate addresses within its network.
const pairSubject = (address: string, ip: string | undefined) =>
  `${address}|${ipLimitSubject(ip ?? NO_TRUSTED_IP)}`;

export function createSendLimiter<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: PgAsyncDatabase<TQueryResult, TRelations>,
  secret: string,
  purpose: SendPurpose,
  now: () => Date = () => new Date(),
): SendLimiter {
  const cooldownIdentifier = identifierFor(secret, purpose);
  const budgets = BUDGETS[purpose].map((budget) => ({
    ...budget,
    identifier: identifierFor(secret, budget.label),
  }));

  const live = (identifier: string, at: Date) =>
    db
      .select({ expiresAt: verification.expiresAt })
      .from(verification)
      .where(
        and(eq(verification.identifier, identifier), gt(verification.expiresAt, at)),
      );

  return {
    async allow(email, ip) {
      const address = normalise(email);
      const at = now();
      const cooldown = cooldownIdentifier(address);
      if ((await live(cooldown, at)).length > 0) return false;
      const keyed = budgets.map((budget) => ({
        ...budget,
        id: budget.identifier(budget.perPair ? pairSubject(address, ip) : address),
      }));
      for (const budget of keyed) {
        if ((await live(budget.id, at)).length >= budget.max) return false;
      }
      await db.insert(verification).values([
        {
          identifier: cooldown,
          value: "1",
          expiresAt: new Date(at.getTime() + SEND_COOLDOWN_SECONDS * 1000),
        },
        ...keyed.map((budget) => ({
          identifier: budget.id,
          value: "1",
          expiresAt: new Date(at.getTime() + budget.windowSeconds * 1000),
        })),
      ]);
      await db
        .delete(verification)
        .where(
          and(
            inArray(verification.identifier, [cooldown, ...keyed.map((b) => b.id)]),
            lte(verification.expiresAt, at),
          ),
        );
      return true;
    },
  };
}
