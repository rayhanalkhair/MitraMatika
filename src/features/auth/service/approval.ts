import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

/** Upper bound on the list size, so a pasted-in mistake cannot make every request slow. */
export const MAX_LIST_ENTRIES = 1000;

export interface ApprovalEnv {
  ALLOWED_EMAILS?: string;
  ADMIN_EMAIL?: string;
}

function normalise(email: string): string {
  return email.trim().toLowerCase();
}

function isWellFormed(entry: string): boolean {
  const parts = entry.split("@");
  return parts.length === 2 && parts[0] !== "" && parts[1] !== "";
}

interface Scan {
  entries: ReadonlySet<string>;
  /** Pieces that are not a well-formed address. */
  malformed: number;
  /** Well-formed addresses beyond MAX_LIST_ENTRIES, which are ignored. */
  dropped: number;
}

function scanEmailList(raw: string | undefined): Scan {
  const entries = new Set<string>();
  let malformed = 0;
  let dropped = 0;
  for (const piece of (raw ?? "").split(/[\s,]+/)) {
    const entry = normalise(piece);
    if (entry === "") continue;
    if (!isWellFormed(entry)) malformed += 1;
    else if (entries.size < MAX_LIST_ENTRIES) entries.add(entry);
    else if (!entries.has(entry)) dropped += 1;
  }
  return { entries, malformed, dropped };
}

/**
 * Splits on commas and whitespace, trims, lower-cases, keeps only entries with exactly one "@"
 * and text on both sides, removes duplicates and keeps at most MAX_LIST_ENTRIES. Matching is
 * exact: no Gmail dot or "+tag" folding.
 */
export function parseEmailList(raw: string | undefined): ReadonlySet<string> {
  return scanEmailList(raw).entries;
}

// One warning per distinct problem and process, so a teacher silently left pending is
// discoverable without a line per request. Counts and the variable name only, never an address.
const warned = new Set<string>();

/** Test hook: forget which problems were already logged. */
export function resetApprovalWarnings(): void {
  warned.clear();
}

function warnOnce(variable: string, malformed: number, dropped: number): void {
  const key = `${variable}:${String(malformed)}:${String(dropped)}`;
  if ((malformed === 0 && dropped === 0) || warned.has(key)) return;
  warned.add(key);
  logger.warn(
    { module: "auth", variable, malformed, dropped },
    "auth: some approval entries are ignored, those accounts stay pending",
  );
}

function readApprovalEnv(): ApprovalEnv {
  const { ALLOWED_EMAILS, ADMIN_EMAIL } = getEnv();
  const list = scanEmailList(ALLOWED_EMAILS);
  warnOnce("ALLOWED_EMAILS", list.malformed, list.dropped);
  const admin = normalise(ADMIN_EMAIL ?? "");
  if (admin !== "" && !isWellFormed(admin)) warnOnce("ADMIN_EMAIL", 1, 0);
  return { ALLOWED_EMAILS, ADMIN_EMAIL };
}

/** True when the address is ADMIN_EMAIL. The environment is read at call time, never cached. */
export function isAdminEmail(
  email: string,
  env: ApprovalEnv = readApprovalEnv(),
): boolean {
  const admin = normalise(env.ADMIN_EMAIL ?? "");
  return isWellFormed(admin) && normalise(email) === admin;
}

/**
 * Approved means the address is ADMIN_EMAIL or is listed in ALLOWED_EMAILS. Meant for a session
 * user's email only (a session exists only for a verified address), so a squatter who typed an
 * approved address without owning it never reaches this check.
 */
export function isApprovedEmail(
  email: string,
  env: ApprovalEnv = readApprovalEnv(),
): boolean {
  if (isAdminEmail(email, env)) return true;
  return parseEmailList(env.ALLOWED_EMAILS).has(normalise(email));
}
