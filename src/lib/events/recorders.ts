import "server-only";
import { and, eq } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import { appErrors, auditLog, usageEvents } from "@/lib/db/schema";
import { clampJson, isValidEventName, normalizeUuid, truncateMessage } from "./sanitize";
import { logger } from "@/lib/logger";

export const AUDIT_SIGN_IN = "sign_in";
export const AUDIT_SIGN_OUT = "sign_out";

export interface AuditEntry {
  ownerId: string;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: unknown;
}

export interface UsageEntry {
  ownerId: string;
  event: string;
  entityType?: string;
  entityId?: string;
  durationMs?: number;
  metadata?: unknown;
}

export interface ErrorEntry {
  ownerId?: string | null;
  correlationId?: string | null;
  source: string;
  code?: string;
  message: string;
  context?: unknown;
}

const MAX_CODE_LENGTH = 64;

// These writes are telemetry: a failure must never break sign-in or a job. They return false
// instead of throwing and log only the record kind and a driver error code, never the payload
// (Drizzle's driver errors embed the query parameters).
async function attempt(kind: string, write: () => Promise<unknown>): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    logger.error(
      { module: "events", code: typeof code === "string" ? code : "" },
      `events: could not record ${kind}`,
    );
    return false;
  }
}

function optionalName(value: string | undefined): string | null | undefined {
  if (value === undefined) return null;
  return isValidEventName(value) ? value : undefined;
}

export async function recordAudit<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(db: PgAsyncDatabase<TQueryResult, TRelations>, entry: AuditEntry): Promise<boolean> {
  let ownerId: string | null;
  let entityType: string | null | undefined;
  try {
    ownerId = normalizeUuid(entry.ownerId);
    entityType = optionalName(entry.entityType);
    if (ownerId === null || !isValidEventName(entry.action)) return false;
  } catch {
    return false;
  }
  if (entityType === undefined) return false;
  return attempt("audit", () =>
    db.insert(auditLog).values({
      ownerId,
      action: entry.action,
      entityType,
      entityId: normalizeUuid(entry.entityId),
      metadata: clampJson(entry.metadata),
    }),
  );
}

/**
 * Whether this owner already has an audit row for that action on that entity. Never throws: a
 * failed read answers false (the caller then writes, which is the safe side for an audit trail).
 */
export async function hasAudit<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: PgAsyncDatabase<TQueryResult, TRelations>,
  entry: Pick<AuditEntry, "ownerId" | "action" | "entityType" | "entityId">,
): Promise<boolean> {
  try {
    const ownerId = normalizeUuid(entry.ownerId);
    const entityId = normalizeUuid(entry.entityId);
    if (ownerId === null || entityId === null || entry.entityType === undefined) {
      return false;
    }
    const rows = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.ownerId, ownerId),
          eq(auditLog.action, entry.action),
          eq(auditLog.entityType, entry.entityType),
          eq(auditLog.entityId, entityId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

export async function recordUsage<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(db: PgAsyncDatabase<TQueryResult, TRelations>, entry: UsageEntry): Promise<boolean> {
  let ownerId: string | null;
  let entityType: string | null | undefined;
  let durationMs: number | undefined;
  try {
    ownerId = normalizeUuid(entry.ownerId);
    entityType = optionalName(entry.entityType);
    durationMs = entry.durationMs;
    if (ownerId === null || !isValidEventName(entry.event)) return false;
    if (durationMs !== undefined && (!Number.isInteger(durationMs) || durationMs < 0)) {
      return false;
    }
  } catch {
    return false;
  }
  if (entityType === undefined) return false;
  return attempt("usage", () =>
    db.insert(usageEvents).values({
      ownerId,
      event: entry.event,
      entityType,
      entityId: normalizeUuid(entry.entityId),
      durationMs: durationMs ?? null,
      metadata: clampJson(entry.metadata),
    }),
  );
}

export async function recordError<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(db: PgAsyncDatabase<TQueryResult, TRelations>, entry: ErrorEntry): Promise<boolean> {
  if (!isValidEventName(entry.source)) return false;
  return attempt("error", () =>
    db.insert(appErrors).values({
      ownerId: entry.ownerId ?? null,
      correlationId: normalizeUuid(entry.correlationId),
      source: entry.source,
      code:
        entry.code === undefined ? null : truncateMessage(entry.code, MAX_CODE_LENGTH),
      message: truncateMessage(entry.message),
      context: clampJson(entry.context),
    }),
  );
}
