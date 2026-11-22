import { getDb } from "@/lib/db/runtime";
import {
  hasAudit,
  recordAudit,
  recordError,
  recordUsage,
  type AuditEntry,
  type ErrorEntry,
  type UsageEntry,
} from "./recorders";

export { AUDIT_SIGN_IN, AUDIT_SIGN_OUT } from "./recorders";
export type { AuditEntry, ErrorEntry, UsageEntry } from "./recorders";

/**
 * Default recorders bound to the runtime database. They never throw, including when the
 * database is not configured (for example the Playwright run, which has no DATABASE_URL).
 */
export async function audit(entry: AuditEntry): Promise<boolean> {
  try {
    return await recordAudit(getDb(), entry);
  } catch {
    return false;
  }
}

export async function auditExists(
  entry: Pick<AuditEntry, "ownerId" | "action" | "entityType" | "entityId">,
): Promise<boolean> {
  try {
    return await hasAudit(getDb(), entry);
  } catch {
    return false;
  }
}

export async function usage(entry: UsageEntry): Promise<boolean> {
  try {
    return await recordUsage(getDb(), entry);
  } catch {
    return false;
  }
}

export async function error(entry: ErrorEntry): Promise<boolean> {
  try {
    return await recordError(getDb(), entry);
  } catch {
    return false;
  }
}
