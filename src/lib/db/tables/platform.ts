import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, ownerId, ownerSelectPolicy, updatedAt } from "./columns";
import { profiles } from "./identity";

export const jobs = pgTable.withRLS(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: ownerId(),
    type: text("type").notNull(),
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("queued"),
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockToken: uuid("lock_token"),
    progress: jsonb("progress"),
    error: jsonb("error"),
    correlationId: uuid("correlation_id").notNull().defaultRandom(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "jobs_status_check",
      sql`${t.status} in ('queued', 'running', 'succeeded', 'failed', 'deferred', 'cancelled')`,
    ),
    unique("jobs_id_owner_unique").on(t.id, t.ownerId),
    index("jobs_status_run_after_idx").on(t.status, t.runAfter),
    ownerSelectPolicy("jobs", t),
  ],
);

export const aiCalls = pgTable.withRLS(
  "ai_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: ownerId(),
    jobId: uuid("job_id"),
    task: text("task").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cachedTokens: integer("cached_tokens"),
    latencyMs: integer("latency_ms"),
    outcome: text("outcome").notNull(),
    errorCode: text("error_code"),
    failurePayload: jsonb("failure_payload"),
    createdAt: createdAt(),
  },
  (t) => [
    check("ai_calls_outcome_check", sql`${t.outcome} in ('ok', 'error')`),
    foreignKey({
      name: "ai_calls_job_owner_fk",
      columns: [t.jobId, t.ownerId],
      foreignColumns: [jobs.id, jobs.ownerId],
    }),
    index("ai_calls_created_at_idx").on(t.createdAt),
    ownerSelectPolicy("ai_calls", t),
  ],
);

// One row per worker attempt at a job, for the job's history. Written only by the service
// connection; the owner can read their own rows. owner_id is nullable like app_errors (a job
// attempt can be recorded before its owner is known) and rows go away with their job.
export const jobRuns = pgTable.withRLS(
  "job_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    outcome: text("outcome").notNull(),
    errorCode: text("error_code"),
    durationMs: integer("duration_ms"),
  },
  (t) => [
    check(
      "job_runs_outcome_check",
      sql`${t.outcome} in ('running', 'succeeded', 'failed', 'deferred')`,
    ),
    index("job_runs_job_id_idx").on(t.jobId),
    ownerSelectPolicy("job_runs", t),
  ],
);

// RLS is enabled on the next three tables with NO policy: deny-all for any role that is
// subject to RLS, even if a grant were ever added by mistake. They are written only through
// the service connection.
export const auditLog = pgTable.withRLS("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Nullable, and set to null when the account is deleted: the trail outlives the account,
  // unlinked from it. The entry recording a deletion never has an owner (counts and a keyed hash
  // of the account id only, account-deletion.ts).
  ownerId: uuid("owner_id").references(() => profiles.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: uuid("entity_id"),
  metadata: jsonb("metadata")
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
});

export const usageEvents = pgTable.withRLS("usage_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: ownerId(),
  event: text("event").notNull(),
  entityType: text("entity_type"),
  entityId: uuid("entity_id"),
  durationMs: integer("duration_ms"),
  metadata: jsonb("metadata")
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
});

export const appErrors = pgTable.withRLS("app_errors", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Nullable: an error can happen with no signed-in user, and it survives account deletion
  // anonymised. Rows with a null owner are invisible to teachers.
  ownerId: uuid("owner_id").references(() => profiles.id, { onDelete: "set null" }),
  correlationId: uuid("correlation_id"),
  source: text("source").notNull(),
  code: text("code"),
  message: text("message").notNull(),
  context: jsonb("context")
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
});

// A permanent record that a question (or other entity) was deleted, with what went with it.
// Written only by the service connection; the owner can read their own rows. The owner is
// nullable and set to null when the account is deleted (like audit_log): the record outlives
// the account, unlinked from it, and becomes visible to the service connection only.
export const deletionLog = pgTable.withRLS(
  "deletion_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id").references(() => profiles.id, { onDelete: "set null" }),
    entity: text("entity").notNull(),
    entityId: uuid("entity_id").notNull(),
    counts: jsonb("counts")
      .notNull()
      .default(sql`'{}'::jsonb`),
    deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [ownerSelectPolicy("deletion_log", t)],
);
