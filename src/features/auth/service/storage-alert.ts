import "server-only";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/runtime";
import { verification } from "@/lib/db/schema";
import { getEmailSender, type SendEmail } from "@/lib/email";
import { getEnv } from "@/lib/env";
import { createStaticTranslator } from "@/lib/i18n/translator";
import type { StepReport } from "@/lib/jobs/tick";
import { logger } from "@/lib/logger";
import { err } from "@/lib/result";
import {
  appStorageUsage,
  type AppStorageUsage,
  type AppTotalDb,
} from "@/lib/storage/app-total";
import {
  createGlobalSendBudget,
  jakartaDay,
  type Reservation,
} from "./global-send-budget";

// The storage alert (ADR-0022, design decision 16): the daily tick mails the admin ONCE when the
// app-wide total reaches 80 percent of the cap and ONCE more when it reaches 100 percent. Once
// means: one `verification` row `storage-alert:<level>` (value = the Jakarta month, a note for
// whoever reads the table) is claimed under an advisory lock before anything is sent; while it
// lives (30 days after a successful send) that level is not mailed again, and when it expires a
// total that is still high mails again. A failed send or a refused budget deletes the claim, so
// the next tick retries. Between the claim and the send the marker lives only MARKER_HOLD_MS, so a
// task that dies in between (a killed function) gives it back within minutes instead of silencing
// the alert for 30 days (the single admin notice has no such way out; see admin-notice.ts).
// A higher level that is live silences the lower one: a total that fell from full back to 85
// percent does not send "nearly full" after "full".
// The email uses the admin's budget kind `adminDigest` (the app-wide 60, which can never take the
// password-reset reserve, and the admin label's 12 a day, whose last two slots are kept for the
// digest and the alerts: single notices stop at 10). The body has counts and percentages only:
// no teacher, no address. Nothing here logs an address; only the purpose, the level and error
// names.

export const STORAGE_ALERT_LEVELS = [0.8, 1] as const;
type AlertLevel = (typeof STORAGE_ALERT_LEVELS)[number];

const MARKER_PREFIX = "storage-alert:";
const MARKER_DAYS = 30;
const MARKER_HOLD_MS = 10 * 60 * 1000;
const MB = 1024 * 1024;

const markerOf = (level: AlertLevel) => `${MARKER_PREFIX}${String(level)}`;
const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

/** The highest level the total has reached (integer comparison, no floating point at the edge). */
function reachedLevel({ usedBytes, capBytes }: AppStorageUsage): AlertLevel | null {
  const reached = STORAGE_ALERT_LEVELS.filter(
    (level) => usedBytes * 100 >= Math.round(level * 100) * capBytes,
  );
  return reached.at(-1) ?? null;
}

export interface StorageAlertDeps {
  db: AppTotalDb;
  getSender?: () => SendEmail;
  now?: () => Date;
  /** The app-wide total; `appStorageUsage(db)` by default. */
  getUsage?: () => Promise<AppStorageUsage>;
  /** The admin address; ADMIN_EMAIL (read at call time) by default. The only source. */
  getAdminEmail?: () => string | undefined;
}

export interface StorageAlerter {
  /** The daily step: computes the total once and mails the admin when a level is newly reached. */
  check(): Promise<StepReport>;
}

export function createStorageAlerter(deps: StorageAlertDeps): StorageAlerter {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const getSender = deps.getSender ?? getEmailSender;
  const getUsage = deps.getUsage ?? (() => appStorageUsage(db));
  const adminEmail =
    deps.getAdminEmail ??
    (() => {
      const address = getEnv().ADMIN_EMAIL?.trim();
      return address === "" ? undefined : address;
    });
  const budget = createGlobalSendBudget(db, now);

  /** Claims the level's marker, or answers null when a marker of this or a higher level lives. */
  async function claim(level: AlertLevel, at: Date): Promise<string | null> {
    const silencing = STORAGE_ALERT_LEVELS.filter((l) => l >= level).map(markerOf);
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${"storage_alert"}, 0))`,
      );
      const live = await tx
        .select({ id: verification.id })
        .from(verification)
        .where(
          and(
            inArray(verification.identifier, silencing),
            gt(verification.expiresAt, at),
          ),
        )
        .limit(1);
      if (live.length > 0) return null;
      await tx.delete(verification).where(eq(verification.identifier, markerOf(level)));
      const [row] = await tx
        .insert(verification)
        .values({
          identifier: markerOf(level),
          value: jakartaDay(at).key.slice(0, 7),
          expiresAt: new Date(at.getTime() + MARKER_HOLD_MS),
        })
        .returning({ id: verification.id });
      return row.id;
    });
  }

  async function check(): Promise<StepReport> {
    const report: StepReport = {};
    let usage: AppStorageUsage;
    try {
      usage = await getUsage();
    } catch (error) {
      logger.error(
        { module: "auth", purpose: "storageAlert", errorName: errorName(error) },
        "auth: the storage alert could not read the app-wide total",
      );
      return { failed: true };
    }
    const level = reachedLevel(usage);
    if (level === null) return report;
    const to = adminEmail();
    if (to === undefined) {
      logger.warn(
        { module: "auth", purpose: "storageAlert", level },
        "auth: no admin address, so no storage alert is sent",
      );
      return report;
    }

    let markerId: string | null = null;
    let reservation: Reservation | null = null;
    let sent = false;
    const at = now();
    try {
      markerId = await claim(level, at);
      if (markerId === null) return report;
      reservation = await budget.reserve("adminDigest");
      if (reservation === null) {
        logger.warn(
          { module: "auth", purpose: "storageAlert", level },
          "auth: the admin email budget is used up; the storage alert waits for the next day",
        );
        report.backlogLeft = true;
        return report;
      }
      const t = createStaticTranslator("auth.email");
      let result: Awaited<ReturnType<SendEmail>>;
      try {
        result = await getSender()({
          to,
          subject: t(level === 1 ? "storageAlertFullSubject" : "storageAlertWarnSubject"),
          text: t("storageAlertBody", {
            used: Math.round(usage.usedBytes / MB),
            cap: Math.round(usage.capBytes / MB),
            percent: Math.floor((usage.usedBytes * 100) / usage.capBytes),
          }),
        });
      } catch (error) {
        result = err(errorName(error));
      }
      if (!result.ok) {
        logger.error(
          { module: "auth", purpose: "storageAlert", level, error: result.error },
          "auth: the storage alert could not be sent",
        );
        report.failed = true;
        return report;
      }
      sent = true;
      logger.info(
        { module: "auth", purpose: "storageAlert", level },
        "auth: sent the storage alert to the admin",
      );
      // Sent: the marker now silences this level for 30 days.
      await db
        .update(verification)
        .set({ expiresAt: new Date(at.getTime() + MARKER_DAYS * 24 * 60 * 60 * 1000) })
        .where(eq(verification.id, markerId));
    } catch (error) {
      logger.error(
        { module: "auth", purpose: "storageAlert", errorName: errorName(error) },
        "auth: the storage alert failed",
      );
      if (!sent) report.failed = true;
    } finally {
      if (reservation !== null) {
        try {
          await (sent ? budget.confirm(reservation) : budget.release(reservation));
        } catch (error) {
          logger.error(
            { module: "auth", errorName: errorName(error) },
            "auth: the daily email budget could not be updated after a storage alert",
          );
        }
      }
      if (markerId !== null && !sent) {
        try {
          await db.delete(verification).where(eq(verification.id, markerId));
        } catch (error) {
          logger.error(
            { module: "auth", purpose: "storageAlert", errorName: errorName(error) },
            "auth: a storage alert marker could not be deleted; the alert retries after it expires",
          );
        }
      }
    }
    return report;
  }

  return { check };
}

/** The daily storage alert step of the jobs tick, on the service connection. */
export function checkStorageAlerts(now?: Date): Promise<StepReport> {
  return createStorageAlerter({
    db: getDb(),
    ...(now === undefined ? {} : { now: () => now }),
  }).check();
}
