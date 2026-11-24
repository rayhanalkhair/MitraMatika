import "server-only";
import { and, desc, eq, exists, inArray, isNull, sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import { getDb } from "@/lib/db/runtime";
import { profiles, user } from "@/lib/db/schema";
import { getEmailSender, type SendEmail } from "@/lib/email";
import { getEnv } from "@/lib/env";
import { createStaticTranslator } from "@/lib/i18n/translator";
import type { StepReport } from "@/lib/jobs/tick";
import { logger } from "@/lib/logger";
import { err } from "@/lib/result";
import { isApprovedEmail } from "./approval";
import { createGlobalSendBudget, type Reservation } from "./global-send-budget";

// The notice to the admin when a VERIFIED account is waiting for approval (ADR-0022, design
// decisions 7 to 9). Exactly once per account: `profiles.admin_notified_at` is claimed with one
// atomic UPDATE ... WHERE admin_notified_at IS NULL, so two triggers (a verification clicked
// twice, the Google link guard racing the daily digest) send one email. The claim is given back
// when the email is not sent (budget refused, sender failed) so the daily digest, which sends one
// email for up to DIGEST_MAX_ACCOUNTS unclaimed accounts, picks the account up. The budget is the
// app-wide one plus a sub-budget for the admin (global-send-budget.ts), so a flood of sign-ups
// can neither flood the admin's inbox nor use the reset reserve. Nothing here logs an address or
// a name: only counts, the purpose and error names.

export const DIGEST_MAX_ACCOUNTS = 25;
const NAME_MAX = 80;
const SCHOOL_MAX = 120;
const EMAIL_MAX_SHOWN = 254;
// The digest looks at this many unmarked verified accounts per run (newest first).
const CANDIDATE_LIMIT = 2000;

type Db<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
> = PgAsyncDatabase<TQueryResult, TRelations>;

/**
 * Plain text for an email body: control and format characters (C0, C1, newlines, zero-width and
 * bidirectional marks) are removed, whitespace is collapsed, and the result is cut to `max`
 * characters. Nothing from a sign-up can add a line or a header to the email.
 */
export function sanitizeLine(text: string, max: number): string {
  const cleaned = text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(cleaned).slice(0, max).join("");
}

export interface ClaimedNotice {
  userId: string;
  email: string;
  name: string;
  schoolName: string | null;
  createdAt: Date;
}

interface ClaimOptions {
  now?: () => Date;
  /** Decides approved or pending (approval.ts reads the environment by default). */
  isApproved?: (email: string) => boolean;
}

async function ensureProfiles<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(db: Db<TQueryResult, TRelations>, rows: { id: string; name: string }[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(profiles)
    .values(rows.map((row) => ({ id: row.id, displayName: row.name })))
    .onConflictDoNothing({ target: profiles.id });
}

/**
 * Claims the notice of one account: returns what the email needs, or null when the account is
 * unknown, not verified, already claimed, or approved (an approved account is claimed without a
 * notice). The profile row is created when missing. The verified check is part of the claiming
 * statement itself.
 */
export async function claimNotice<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: Db<TQueryResult, TRelations>,
  userId: string,
  { now = () => new Date(), isApproved = isApprovedEmail }: ClaimOptions = {},
): Promise<ClaimedNotice | null> {
  const found = (
    await db
      .select({
        email: user.email,
        name: user.name,
        verified: user.emailVerified,
        createdAt: user.createdAt,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1)
  ).at(0);
  if (found?.verified !== true) return null;
  // Decided BEFORE the claim: the predicate reads the environment and can throw, and a throw
  // after the UPDATE would leave the account claimed and never announced.
  const approved = isApproved(found.email);
  await ensureProfiles(db, [{ id: userId, name: found.name }]);
  const claimed = await db
    .update(profiles)
    .set({ adminNotifiedAt: now() })
    .where(
      and(
        eq(profiles.id, userId),
        isNull(profiles.adminNotifiedAt),
        exists(
          db
            .select({ one: sql`1` })
            .from(user)
            .where(and(eq(user.id, userId), eq(user.emailVerified, true))),
        ),
      ),
    )
    .returning({ displayName: profiles.displayName, schoolName: profiles.schoolName });
  if (claimed.length === 0 || approved) return null;
  return {
    userId,
    email: found.email,
    name: claimed[0].displayName ?? found.name,
    schoolName: claimed[0].schoolName,
    createdAt: found.createdAt,
  };
}

/** Gives the claim back (the notice was not sent), so the daily digest can pick it up. */
export async function releaseNotice<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(db: Db<TQueryResult, TRelations>, userId: string | string[]): Promise<void> {
  const ids = Array.isArray(userId) ? userId : [userId];
  if (ids.length === 0) return;
  await db
    .update(profiles)
    .set({ adminNotifiedAt: null })
    .where(inArray(profiles.id, ids));
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

const jakartaTime = (at: Date): string =>
  `${new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at)} WIB`;

interface Listed {
  email: string;
  name: string;
  schoolName: string | null;
  createdAt: Date;
}

const entryFields = (entry: Listed) => ({
  email: sanitizeLine(entry.email, EMAIL_MAX_SHOWN),
  name: sanitizeLine(entry.name, NAME_MAX) || "-",
  school: sanitizeLine(entry.schoolName ?? "", SCHOOL_MAX) || "-",
  time: jakartaTime(entry.createdAt),
});

export interface AdminNoticeDeps<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
> {
  db: Db<TQueryResult, TRelations>;
  getSender?: () => SendEmail;
  now?: () => Date;
  isApproved?: (email: string) => boolean;
  /** The admin address; ADMIN_EMAIL (read at call time) by default. The only source. */
  getAdminEmail?: () => string | undefined;
}

export interface AdminNotifier {
  /** One notice for one account; background-safe: never rejects. */
  notify(userId: string): Promise<void>;
  /** The daily digest of the accounts no single notice went out for. */
  digest(): Promise<StepReport>;
}

export function createAdminNotifier<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(deps: AdminNoticeDeps<TQueryResult, TRelations>): AdminNotifier {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const isApproved = deps.isApproved ?? isApprovedEmail;
  const getSender = deps.getSender ?? getEmailSender;
  const adminEmail =
    deps.getAdminEmail ??
    (() => {
      const address = getEnv().ADMIN_EMAIL?.trim();
      return address === "" ? undefined : address;
    });
  const budget = createGlobalSendBudget(db, now);

  async function settle(reservation: Reservation | null, sent: boolean): Promise<void> {
    if (reservation === null) return;
    try {
      await (sent ? budget.confirm(reservation) : budget.release(reservation));
    } catch (error) {
      logger.error(
        { module: "auth", errorName: errorName(error) },
        "auth: the daily email budget could not be updated after an admin email",
      );
    }
  }

  async function giveBack(ids: string[]): Promise<void> {
    try {
      await releaseNotice(db, ids);
    } catch (error) {
      logger.error(
        { module: "auth", errorName: errorName(error) },
        "auth: an admin notice claim could not be given back; the account is not announced",
      );
    }
  }

  async function notify(userId: string): Promise<void> {
    let claimed = false;
    let reservation: Reservation | null = null;
    let sent = false;
    try {
      const to = adminEmail();
      // No address: nothing is claimed, so the account stays for the digest (which logs it).
      if (to === undefined) return;
      const notice = await claimNotice(db, userId, { now, isApproved });
      if (notice === null) return;
      claimed = true;
      reservation = await budget.reserve("adminNotice");
      if (reservation === null) {
        logger.warn(
          { module: "auth", purpose: "adminNotice" },
          "auth: the admin notice budget is used up; the daily digest will list this account",
        );
        return;
      }
      const t = createStaticTranslator("auth.email");
      const result = await getSender()({
        to,
        subject: t("adminNoticeSubject"),
        text: t("adminNoticeBody", entryFields(notice)),
      });
      if (!result.ok) {
        logger.error(
          { module: "auth", purpose: "adminNotice", error: result.error },
          "auth: the admin notice could not be sent",
        );
        return;
      }
      sent = true;
    } catch (error) {
      logger.error(
        { module: "auth", purpose: "adminNotice", errorName: errorName(error) },
        "auth: the admin notice failed",
      );
    } finally {
      await settle(reservation, sent);
      if (claimed && !sent) await giveBack([userId]);
    }
  }

  // The digest marks its accounts only AFTER a successful send, inside one transaction that holds
  // an advisory lock: a send that fails or a task that dies leaves the accounts unmarked for the
  // next run, and two digests cannot both send (the second waits, then finds nothing). A single
  // notice (above) claims BEFORE it sends, which is what keeps it to one email per account; the
  // price is that a task killed between the claim and the send loses that one notice and the
  // digest cannot recover it (it only sees unmarked accounts).
  async function digest(): Promise<StepReport> {
    const report: StepReport = {};
    try {
      const to = adminEmail();
      if (to === undefined) {
        logger.warn(
          { module: "auth" },
          "auth: no admin address, so no admin notice is sent",
        );
        return report;
      }
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${"admin_digest"}, 0))`,
        );
        // The NEWEST first: a flood of old sign-ups cannot hide a new one, and the body states
        // the total, so the admin always sees how many more are waiting.
        const candidates = await tx
          .select({
            id: user.id,
            email: user.email,
            name: user.name,
            createdAt: user.createdAt,
            displayName: profiles.displayName,
            schoolName: profiles.schoolName,
          })
          .from(user)
          .leftJoin(profiles, eq(profiles.id, user.id))
          .where(and(eq(user.emailVerified, true), isNull(profiles.adminNotifiedAt)))
          .orderBy(desc(user.createdAt))
          .limit(CANDIDATE_LIMIT);
        // Decided before anything is written: a throwing predicate changes nothing.
        const approved = candidates.filter((row) => isApproved(row.email));
        const waiting = candidates.filter((row) => !isApproved(row.email));
        const listed = waiting.slice(0, DIGEST_MAX_ACCOUNTS);
        if (waiting.length > listed.length) report.backlogLeft = true;
        const budgetTx = createGlobalSendBudget(tx, now);
        let reservation: Reservation | null = null;
        let sent = listed.length === 0;
        if (listed.length > 0) {
          reservation = await budgetTx.reserve("adminDigest");
          if (reservation === null) {
            logger.warn(
              { module: "auth", purpose: "adminDigest", accounts: listed.length },
              "auth: the admin email budget is used up; the digest waits for the next day",
            );
            report.backlogLeft = true;
            return;
          }
          const t = createStaticTranslator("auth.email");
          const lines = listed.map((row) => {
            const f = entryFields({
              email: row.email,
              name: row.displayName ?? row.name,
              schoolName: row.schoolName,
              createdAt: row.createdAt,
            });
            return `- ${f.email} | ${f.name} | ${f.school} | ${f.time}`;
          });
          let result: Awaited<ReturnType<SendEmail>>;
          try {
            result = await getSender()({
              to,
              subject: t("adminDigestSubject"),
              text: t("adminDigestBody", {
                total: waiting.length,
                count: listed.length,
                list: lines.join("\n"),
              }),
            });
          } catch (error) {
            result = err(errorName(error));
          }
          sent = result.ok;
          if (!result.ok) {
            logger.error(
              { module: "auth", purpose: "adminDigest", error: result.error },
              "auth: the admin digest could not be sent",
            );
            report.failed = true;
          }
          await (sent ? budgetTx.confirm(reservation) : budgetTx.release(reservation));
        }
        if (!sent) return;
        // Marked after the send. An account a single notice claimed meanwhile keeps its first
        // mark (the conditional update), and may be listed twice (harmless).
        const marked = [...approved, ...listed].map((row) => ({
          id: row.id,
          displayName: row.name,
          adminNotifiedAt: now(),
        }));
        if (marked.length > 0) {
          await tx
            .insert(profiles)
            .values(marked)
            .onConflictDoUpdate({
              target: profiles.id,
              set: { adminNotifiedAt: now() },
              setWhere: isNull(profiles.adminNotifiedAt),
            });
        }
        if (listed.length > 0) {
          logger.info(
            { module: "auth", accounts: listed.length, waiting: waiting.length },
            "auth: sent the admin digest of accounts waiting for approval",
          );
        }
      });
    } catch (error) {
      logger.error(
        { module: "auth", purpose: "adminDigest", errorName: errorName(error) },
        "auth: the admin digest failed",
      );
      report.failed = true;
    }
    return report;
  }

  return { notify, digest };
}

/** The notice for one account on the service connection (background-safe, never throws). */
export function notifyAdminOfAccount(userId: string): Promise<void> {
  return createAdminNotifier({ db: getDb() }).notify(userId);
}

/** The daily digest step of the jobs tick. */
export function sendPendingDigest(now?: Date): Promise<StepReport> {
  return createAdminNotifier({
    db: getDb(),
    ...(now === undefined ? {} : { now: () => now }),
  }).digest();
}
