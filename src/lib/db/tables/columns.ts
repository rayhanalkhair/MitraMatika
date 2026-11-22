import { sql } from "drizzle-orm";
import { pgPolicy, timestamp, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { profiles } from "./identity";
import { authenticatedRole } from "./roles";

export const ownerId = () =>
  uuid("owner_id")
    .notNull()
    .references(() => profiles.id, { onDelete: "cascade" });

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// The verifier's outcomes (questions, verification runs, solver solutions), as a SQL list.
export const VERIFICATION_STATUSES =
  "'terverifikasi', 'dicek_silang_ai', 'belum_dapat_diverifikasi', 'ketidaksesuaian'";

interface OwnedTable {
  ownerId: AnyPgColumn;
}

export const ownerSelectPolicy = (name: string, table: OwnedTable) =>
  pgPolicy(`${name}_owner_select`, {
    for: "select",
    to: authenticatedRole,
    using: sql`${table.ownerId} = auth.uid()`,
  });

export const ownerInsertPolicy = (name: string, table: OwnedTable) =>
  pgPolicy(`${name}_owner_insert`, {
    for: "insert",
    to: authenticatedRole,
    withCheck: sql`${table.ownerId} = auth.uid()`,
  });

export const ownerDeletePolicy = (name: string, table: OwnedTable) =>
  pgPolicy(`${name}_owner_delete`, {
    for: "delete",
    to: authenticatedRole,
    using: sql`${table.ownerId} = auth.uid()`,
  });

export const ownerUpdatePolicy = (name: string, table: OwnedTable) =>
  pgPolicy(`${name}_owner_update`, {
    for: "update",
    to: authenticatedRole,
    using: sql`${table.ownerId} = auth.uid()`,
    withCheck: sql`${table.ownerId} = auth.uid()`,
  });
