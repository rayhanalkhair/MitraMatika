import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import {
  createdAt,
  ownerId,
  ownerInsertPolicy,
  ownerSelectPolicy,
  updatedAt,
} from "./columns";
import { curriculumVersions } from "./curriculum";
import { jobs } from "./platform";

export const generationRequests = pgTable.withRLS(
  "generation_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: ownerId(),
    mode: text("mode").notNull().default("topic"),
    inputKind: text("input_kind").notNull().default("form"),
    chatText: text("chat_text"),
    params: jsonb("params")
      .notNull()
      .default(sql`'{}'::jsonb`),
    sourceSelection: jsonb("source_selection"),
    status: text("status").notNull().default("queued"),
    jobId: uuid("job_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("generation_requests_mode_check", sql`${t.mode} in ('topic', 'material')`),
    check(
      "generation_requests_input_kind_check",
      sql`${t.inputKind} in ('form', 'chat')`,
    ),
    check(
      "generation_requests_status_check",
      sql`${t.status} in ('queued', 'running', 'succeeded', 'partial', 'failed', 'deferred', 'cancelled')`,
    ),
    unique("generation_requests_id_owner_unique").on(t.id, t.ownerId),
    foreignKey({
      name: "generation_requests_job_owner_fk",
      columns: [t.jobId, t.ownerId],
      foreignColumns: [jobs.id, jobs.ownerId],
    }),
    ownerSelectPolicy("generation_requests", t),
    ownerInsertPolicy("generation_requests", t),
  ],
);

export const generationRuns = pgTable.withRLS(
  "generation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: ownerId(),
    requestId: uuid("request_id").notNull(),
    task: text("task").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    curriculumVersionId: uuid("curriculum_version_id").references(
      () => curriculumVersions.id,
    ),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cachedTokens: integer("cached_tokens"),
    latencyMs: integer("latency_ms"),
    outcome: text("outcome").notNull(),
    errorCode: text("error_code"),
    createdAt: createdAt(),
  },
  (t) => [
    check("generation_runs_outcome_check", sql`${t.outcome} in ('ok', 'error')`),
    unique("generation_runs_id_owner_unique").on(t.id, t.ownerId),
    foreignKey({
      name: "generation_runs_request_owner_fk",
      columns: [t.requestId, t.ownerId],
      foreignColumns: [generationRequests.id, generationRequests.ownerId],
    }).onDelete("cascade"),
    ownerSelectPolicy("generation_runs", t),
  ],
);
