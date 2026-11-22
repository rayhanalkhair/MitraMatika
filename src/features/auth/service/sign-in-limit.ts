import { and, asc, eq, gt } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import { verification } from "@/lib/db/schema";
import { forgetEvent, hashedIdentifier, recordEvent } from "./attempt-counter";

// Per address: at most 10 failed password sign-ins in 15 minutes (final review I3), however many
// client IPs they come from; Better Auth's per-IP limit (5 a minute) cannot see a guess spread
// over many networks. Applied in Better Auth's request hooks (auth-server.ts) to every address the
// same way, whether it has an account or not, so the refusal (429 TOO_MANY_ATTEMPTS, like the
// per-IP limit) tells nothing about the address. Once refused, even the right password is refused
// until the window ends. Accepted residual: anyone can lock an address out of password sign-in for
// up to 15 minutes at a time; Google sign-in and the reset link still work.
export const SIGN_IN_FAILURES_PER_ADDRESS = 10;
export const SIGN_IN_FAILURE_WINDOW_SECONDS = 15 * 60;

const LABEL = "sign-in-failure";

/** The `verification` identifier of an address's sign-in failures (no address stored). */
export function signInFailureIdentifier(secret: string, email: string): string {
  return hashedIdentifier(secret, LABEL, email.trim().toLowerCase());
}

export interface SignInFailureLimiter {
  /**
   * Before the password is checked: records the attempt and answers whether it may go ahead.
   * A refused attempt is not kept. Rejects on a database error.
   */
  begin(email: string): Promise<boolean>;
  /** After an attempt that went ahead and did NOT fail on the password: un-counts one attempt. */
  settle(email: string): Promise<void>;
}

/**
 * Every attempt is recorded before the password is checked and counted (so parallel guesses
 * cannot slip past the limit), and an attempt that did not end in a wrong-password answer is
 * taken back afterwards: the live rows are the failures of the window plus attempts in flight.
 */
export function createSignInFailureLimiter<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: PgAsyncDatabase<TQueryResult, TRelations>,
  secret: string,
  now: () => Date = () => new Date(),
): SignInFailureLimiter {
  return {
    async begin(email) {
      const at = now();
      const { id, live } = await recordEvent(
        db,
        signInFailureIdentifier(secret, email),
        at,
        new Date(at.getTime() + SIGN_IN_FAILURE_WINDOW_SECONDS * 1000),
      );
      if (live <= SIGN_IN_FAILURES_PER_ADDRESS) return true;
      await forgetEvent(db, id);
      return false;
    },
    async settle(email) {
      const identifier = signInFailureIdentifier(secret, email);
      const one = (
        await db
          .select({ id: verification.id })
          .from(verification)
          .where(
            and(
              eq(verification.identifier, identifier),
              gt(verification.expiresAt, now()),
            ),
          )
          .orderBy(asc(verification.createdAt))
          .limit(1)
      ).at(0);
      if (one) await forgetEvent(db, one.id);
    },
  };
}
