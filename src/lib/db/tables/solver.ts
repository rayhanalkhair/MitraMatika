import { sql } from "drizzle-orm";
import {
  boolean,
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
import {
  createdAt,
  ownerId,
  ownerSelectPolicy,
  updatedAt,
  VERIFICATION_STATUSES,
} from "./columns";
import { generationRuns } from "./generation";

// The solver writes every row on the service connection with explicit owner filters: a session's
// status gates solving (an uncertain extraction must be confirmed first, SOL-02), its input_key
// names a stored photo, solves count toward the daily cap, and the verification fields come from
// the verifier. The teacher only reads them (owner select policy).

export const solverSessions = pgTable.withRLS(
  "solver_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: ownerId(),
    inputKind: text("input_kind").notNull(),
    inputText: text("input_text"),
    // Object-store key of the photo or file page; the photo itself is deleted after 7 days.
    inputKey: text("input_key"),
    // Bytes of the stored photo (reserved at start, the stripped size at finalise); summed by the
    // app-wide storage total while input_key is not null (ADR-0022). Null for older rows.
    inputBytes: integer("input_bytes"),
    extractedMd: text("extracted_md"),
    extractionFlags: jsonb("extraction_flags")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // The problem text the solver works on, after the teacher's confirmation.
    confirmedMd: text("confirmed_md"),
    status: text("status").notNull().default("pending"),
    // When the 7-day photo sweep last failed to delete this session's photo (server-only): the
    // sweep tries the least recently tried rows first, so a row that keeps failing cannot starve
    // the others. Never updated_at, which the teacher's own actions move.
    photoSweepAttemptedAt: timestamp("photo_sweep_attempted_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    purgeAfter: timestamp("purge_after", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "solver_sessions_input_kind_check",
      sql`${t.inputKind} in ('text', 'photo', 'file')`,
    ),
    check(
      "solver_sessions_text_input_check",
      sql`${t.inputKind} <> 'text' or ${t.inputText} is not null`,
    ),
    check(
      "solver_sessions_status_check",
      sql`${t.status} in ('pending', 'extracting', 'needs_confirmation', 'ready', 'solved', 'failed')`,
    ),
    check(
      "solver_sessions_extraction_flags_check",
      sql`jsonb_typeof(${t.extractionFlags}) = 'array'`,
    ),
    unique("solver_sessions_id_owner_unique").on(t.id, t.ownerId),
    // The "recent" list (last 20, newest first, trash excluded).
    index("solver_sessions_owner_recent_idx").on(
      t.ownerId,
      t.deletedAt,
      t.createdAt.desc(),
    ),
    // The 7-day photo purge.
    index("solver_sessions_photo_purge_idx")
      .on(t.createdAt)
      .where(sql`${t.inputKey} is not null`),
    ownerSelectPolicy("solver_sessions", t),
  ],
);

export const solverSolutions = pgTable.withRLS(
  "solver_solutions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: ownerId(),
    sessionId: uuid("session_id").notNull(),
    methodLabel: text("method_label").notNull(),
    // false for the first solution, true for each "show another method" (SOL-04).
    isAlternative: boolean("is_alternative").notNull().default(false),
    steps: jsonb("steps").notNull(),
    // Value, units and rounding.
    finalAnswer: jsonb("final_answer").notNull(),
    verificationStatus: text("verification_status").notNull(),
    verificationReport: jsonb("verification_report"),
    generationRunId: uuid("generation_run_id"),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "solver_solutions_verification_status_check",
      sql.raw(`"verification_status" in (${VERIFICATION_STATUSES})`),
    ),
    check("solver_solutions_method_label_check", sql`btrim(${t.methodLabel}) <> ''`),
    foreignKey({
      name: "solver_solutions_session_owner_fk",
      columns: [t.sessionId, t.ownerId],
      foreignColumns: [solverSessions.id, solverSessions.ownerId],
    }).onDelete("cascade"),
    foreignKey({
      name: "solver_solutions_run_owner_fk",
      columns: [t.generationRunId, t.ownerId],
      foreignColumns: [generationRuns.id, generationRuns.ownerId],
    }),
    index("solver_solutions_session_idx").on(t.sessionId),
    index("solver_solutions_run_idx").on(t.generationRunId),
    ownerSelectPolicy("solver_solutions", t),
  ],
);
