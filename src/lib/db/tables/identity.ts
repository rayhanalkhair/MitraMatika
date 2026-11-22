import { sql } from "drizzle-orm";
import { pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { authenticatedRole } from "./roles";

export const profiles = pgTable.withRLS(
  "profiles",
  {
    id: uuid("id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    displayName: text("display_name"),
    // Optional, from sign-up or the account settings (up to 120 characters, checked in the app).
    schoolName: text("school_name"),
    // When the admin was told this account is waiting (ADR-0022): claimed atomically so the notice
    // goes out once; null until then, and back to null when the send was refused or failed so the
    // daily digest retries. Written by the service connection only.
    adminNotifiedAt: timestamp("admin_notified_at", { withTimezone: true }),
    locale: text("locale").notNull().default("id-ID"),
    timezone: text("timezone").notNull().default("Asia/Jakarta"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    pgPolicy("profiles_self_access", {
      for: "all",
      to: authenticatedRole,
      using: sql`${table.id} = auth.uid()`,
      withCheck: sql`${table.id} = auth.uid()`,
    }),
  ],
);

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
