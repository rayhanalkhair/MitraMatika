import { getEnv } from "@/lib/env";

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

/**
 * Splits on commas and whitespace, trims, lower-cases, keeps only entries with exactly one "@"
 * and text on both sides, removes duplicates and keeps at most MAX_LIST_ENTRIES. Matching is
 * exact: no Gmail dot or "+tag" folding.
 */
export function parseEmailList(raw: string | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const piece of raw.split(/[\s,]+/)) {
    const entry = normalise(piece);
    if (entry === "" || !isWellFormed(entry)) continue;
    out.add(entry);
    if (out.size >= MAX_LIST_ENTRIES) break;
  }
  return out;
}

function readApprovalEnv(): ApprovalEnv {
  const { ALLOWED_EMAILS, ADMIN_EMAIL } = getEnv();
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
