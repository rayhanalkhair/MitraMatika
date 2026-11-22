import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import { hashedIdentifier, recordEvent } from "./attempt-counter";
import { ipLimitSubject } from "./client-ip";

// Per client IP, per 24 hours, on top of Better Auth's per-minute limits (it allows one window per
// path): every route that sends an account email to an address the caller names. Each such
// request can spend one email of the app-wide daily budget (global-send-budget.ts), so these caps
// bound what one network can take of it, and how many unverified accounts it can create.
// Counted in Better Auth's request hook (auth-server.ts) by the resolved client IP; without one,
// every such request shares the "no-trusted-ip" key (fail closed, like Better Auth's own limiter).
// A refused attempt counts too. Sign-in's resend of the verification link (sendOnSignIn) is not
// capped at its route (that would cap sign-ins), but each resend it triggers counts against this
// IP's "/send-verification-email" cap before the email is sent (auth-emails.ts `countAs`), since an
// attacker knows the passwords of their own unverified sign-ups.
export const SIGN_UPS_PER_IP_PER_DAY = 10;
export const RESET_REQUESTS_PER_IP_PER_DAY = 10;
export const VERIFICATION_RESENDS_PER_IP_PER_DAY = 10;
export const IP_DAILY_WINDOW_SECONDS = 24 * 60 * 60;
export const NO_TRUSTED_IP = "no-trusted-ip";

/** The capped paths: the `verification` label of each and its daily maximum per IP. */
export const IP_DAILY_CAPS: Readonly<
  Partial<Record<string, { label: string; max: number }>>
> = {
  "/sign-up/email": { label: "sign-up-ip", max: SIGN_UPS_PER_IP_PER_DAY },
  "/request-password-reset": {
    label: "reset-request-ip",
    max: RESET_REQUESTS_PER_IP_PER_DAY,
  },
  "/send-verification-email": {
    label: "verification-resend-ip",
    max: VERIFICATION_RESENDS_PER_IP_PER_DAY,
  },
};

/** The `verification` identifier of one client IP's attempts on `path` (no raw IP stored). */
export function ipDailyIdentifier(secret: string, path: string, ip: string): string {
  const cap = IP_DAILY_CAPS[path];
  if (!cap) throw new Error(`no daily IP cap for ${path}`);
  // IPv6 by its /64 (client-ip.ts), so one host cannot rotate addresses within its network.
  return hashedIdentifier(secret, cap.label, ipLimitSubject(ip));
}

export const signUpIpIdentifier = (secret: string, ip: string) =>
  ipDailyIdentifier(secret, "/sign-up/email", ip);

export interface IpDailyLimiter {
  /**
   * True when `path` has no daily cap, or when one more attempt from `ip` is allowed today;
   * records it (refusals count too). Rejects on a database error.
   */
  allow(path: string, ip: string | undefined): Promise<boolean>;
}

export function createIpDailyLimiter<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: PgAsyncDatabase<TQueryResult, TRelations>,
  secret: string,
  now: () => Date = () => new Date(),
): IpDailyLimiter {
  return {
    async allow(path, ip) {
      const cap = IP_DAILY_CAPS[path];
      if (!cap) return true;
      const at = now();
      const { live } = await recordEvent(
        db,
        ipDailyIdentifier(secret, path, ip ?? NO_TRUSTED_IP),
        at,
        new Date(at.getTime() + IP_DAILY_WINDOW_SECONDS * 1000),
      );
      return live <= cap.max;
    },
  };
}
