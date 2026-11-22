import "server-only";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import { getEmailSender, type EmailMessage, type SendEmail } from "@/lib/email";
import { createStaticTranslator } from "@/lib/i18n/translator";
import { logger } from "@/lib/logger";
import { err } from "@/lib/result";
import { runAfterResponse } from "./background";
import { createGlobalSendBudget, type Reservation } from "./global-send-budget";
import { createSendLimiter, type SendPurpose } from "./send-limit";

// Decision 3: a verification link lives 24 hours. Decision 4: a reset link lives 1 hour.
export const VERIFICATION_LINK_EXPIRES_IN_SECONDS = 24 * 60 * 60;
export const RESET_LINK_EXPIRES_IN_SECONDS = 60 * 60;

export interface AuthEmailDeps<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
> {
  db: PgAsyncDatabase<TQueryResult, TRelations>;
  /** The auth secret; the per-address limiter derives its hashing key from it. */
  secret: string;
  /** The app's origin, for the sign-in and forgot-password links. */
  appUrl: string;
  getSender?: () => SendEmail;
  /** Where the sending goes. Defaults to Next's after(); tests collect it. */
  runInBackground?: (task: Promise<unknown>) => void;
  /** The clock of the per-address limiter. */
  now?: () => Date;
  /**
   * The per-IP daily caps (ip-daily-limit.ts), for an email whose request is not already capped
   * at its route (`countAs` below). Records the attempt.
   */
  allowFromIp?: (path: string, ip: string | undefined) => Promise<boolean>;
}

export interface AuthEmails {
  /** `ip`: the requesting client's resolved IP (the per-pair budget), when there is a request. */
  sendVerificationEmail(input: {
    email: string;
    url: string;
    ip?: string;
    /**
     * The capped route this email counts against per client IP, when its own route has no daily
     * cap (the resend on a sign-in counts as a "/send-verification-email").
     */
    countAs?: string;
  }): Promise<void>;
  sendResetEmail(input: { email: string; url: string; ip?: string }): Promise<void>;
  sendAccountExistsEmail(input: { email: string }): Promise<void>;
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

const logLimitError = (purpose: SendPurpose, error: unknown) => {
  logger.error(
    { module: "auth", purpose, errorName: errorName(error) },
    "auth: the email limit could not be checked, so no account email was sent",
  );
};

/**
 * The account emails. Each call only hands the work to the background and resolves at once, so
 * neither the limiter, the send nor a failure can change the response or its timing (an
 * existing address must answer like a new one). In the background: the app-wide daily budget
 * (global-send-budget.ts; a refusal is logged at error), then the per-address limit (1 per
 * 60 s for that kind of email; for verification and reset emails each, 3 per hour per address and
 * client IP and 20 per day per address; 3 per hour for account-exists emails; see send-limit.ts;
 * a refusal is silent and gives the app-wide reservation back), then the send (a failed send gives
 * it back too).
 * Background work has no request, so the copy is always in the default locale (Indonesian). Logs
 * carry an error name or code only, never the address or the link.
 */
export function createAuthEmails<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(deps: AuthEmailDeps<TQueryResult, TRelations>): AuthEmails {
  const getSender = deps.getSender ?? getEmailSender;
  const runInBackground = deps.runInBackground ?? runAfterResponse;
  const appUrl = new URL(deps.appUrl).origin;
  const limiters = {
    verify: createSendLimiter(deps.db, deps.secret, "verify", deps.now),
    reset: createSendLimiter(deps.db, deps.secret, "reset", deps.now),
    accountExists: createSendLimiter(deps.db, deps.secret, "accountExists", deps.now),
  } satisfies Record<SendPurpose, unknown>;
  const dailyBudget = createGlobalSendBudget(deps.db, deps.now);

  async function deliver(
    purpose: SendPurpose,
    email: string,
    ip: string | undefined,
    build: () => Omit<EmailMessage, "to">,
    countAs?: string,
  ): Promise<void> {
    // An email whose route is not capped per IP per day counts against the route it stands for;
    // over that cap it is dropped silently, before any budget is touched.
    if (countAs !== undefined && deps.allowFromIp) {
      try {
        if (!(await deps.allowFromIp(countAs, ip))) return;
      } catch (error) {
        logLimitError(purpose, error);
        return;
      }
    }
    // The app-wide budget is reserved first and confirmed only once the email has gone out: the
    // reservation is given back when the per-address limit refuses, when a check or the send
    // fails, and on its own after a few minutes if this task dies in between. So a refused or
    // failed email uses up neither budget.
    let reservation: Reservation | null;
    try {
      reservation = await dailyBudget.reserve(purpose);
    } catch (error) {
      logLimitError(purpose, error);
      return;
    }
    if (reservation === null) {
      logger.error(
        { module: "auth", purpose },
        "auth: the app-wide daily budget of account emails is used up, so this one was not sent",
      );
      return;
    }
    let sent = false;
    try {
      let allowed: boolean;
      try {
        allowed = await limiters[purpose].allow(email, ip);
      } catch (error) {
        logLimitError(purpose, error);
        return;
      }
      if (!allowed) return;
      let result: Awaited<ReturnType<SendEmail>>;
      try {
        result = await getSender()({ to: email, ...build() });
      } catch (error) {
        result = err(errorName(error));
      }
      if (!result.ok) {
        logger.error(
          { module: "auth", purpose, error: result.error },
          "auth: an account email could not be sent",
        );
        return;
      }
      sent = true;
    } finally {
      await settleReservation(reservation, sent);
    }
  }

  async function settleReservation(reservation: Reservation, sent: boolean) {
    try {
      await (sent ? dailyBudget.confirm(reservation) : dailyBudget.release(reservation));
    } catch (error) {
      // The reservation then expires on its own (RESERVATION_HOLD_SECONDS).
      logger.error(
        { module: "auth", errorName: errorName(error) },
        "auth: the daily email budget could not be updated after a send",
      );
    }
  }

  const schedule = (
    purpose: SendPurpose,
    email: string,
    ip: string | undefined,
    build: () => Omit<EmailMessage, "to">,
    countAs?: string,
  ): Promise<void> => {
    runInBackground(deliver(purpose, email, ip, build, countAs));
    return Promise.resolve();
  };

  return {
    sendVerificationEmail: ({ email, url, ip, countAs }) =>
      schedule(
        "verify",
        email,
        ip,
        () => {
          const t = createStaticTranslator("auth.email");
          return {
            subject: t("verifySubject"),
            text: t("verifyBody", {
              url,
              hours: VERIFICATION_LINK_EXPIRES_IN_SECONDS / 3600,
            }),
          };
        },
        countAs,
      ),
    sendResetEmail: ({ email, url, ip }) =>
      schedule("reset", email, ip, () => {
        const t = createStaticTranslator("auth.email");
        return {
          subject: t("resetSubject"),
          text: t("resetBody", { url, minutes: RESET_LINK_EXPIRES_IN_SECONDS / 60 }),
        };
      }),
    sendAccountExistsEmail: ({ email }) =>
      schedule("accountExists", email, undefined, () => {
        const t = createStaticTranslator("auth.email");
        return {
          subject: t("accountExistsSubject"),
          text: t("accountExistsBody", {
            signInUrl: `${appUrl}/sign-in`,
            resetUrl: `${appUrl}/forgot-password`,
          }),
        };
      }),
  };
}
