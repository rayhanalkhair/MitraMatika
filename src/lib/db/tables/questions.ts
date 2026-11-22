import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import {
  createdAt,
  ownerId,
  ownerSelectPolicy,
  ownerUpdatePolicy,
  updatedAt,
  VERIFICATION_STATUSES,
} from "./columns";
import { learningObjectives, topics } from "./curriculum";
import { generationRequests, generationRuns } from "./generation";

export const questions = pgTable.withRLS(
  "questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: ownerId(),
    status: text("status").notNull().default("draft"),
    origin: text("origin").notNull().default("generated"),
    grade: smallint("grade").notNull(),
    type: text("type").notNull().default("multiple_choice"),
    difficulty: text("difficulty").notNull(),
    cognitiveLevel: text("cognitive_level"),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topics.id),
    learningObjectiveId: uuid("learning_objective_id").references(
      () => learningObjectives.id,
    ),
    // The next two reference question_versions through composite, DEFERRABLE foreign keys
    // that exist only in the hand-written privileges migration: the two tables reference each
    // other, and Drizzle cannot express a deferrable constraint.
    currentVersionId: uuid("current_version_id"),
    approvedVersionId: uuid("approved_version_id"),
    generationRequestId: uuid("generation_request_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvalOverride: jsonb("approval_override"),
    bankedAt: timestamp("banked_at", { withTimezone: true }),
    // Trash: a question with deleted_at set is in the trash until purge_after, then it is purged.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    purgeAfter: timestamp("purge_after", { withTimezone: true }),
    // Lower-cased, accent-free stem + options + explanation + TP code of the current version,
    // rewritten by the app on every version change. Searched with the trigram index below.
    searchText: text("search_text").notNull().default(""),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "questions_status_check",
      sql`${t.status} in ('draft', 'approved', 'archived')`,
    ),
    check(
      "questions_origin_check",
      sql`${t.origin} in ('generated', 'manual', 'imported')`,
    ),
    check("questions_grade_check", sql`${t.grade} in (7, 8, 9)`),
    check("questions_type_check", sql`${t.type} in ('multiple_choice')`),
    check(
      "questions_difficulty_check",
      sql`${t.difficulty} in ('mudah', 'sedang', 'sulit')`,
    ),
    unique("questions_id_owner_unique").on(t.id, t.ownerId),
    // The pg_trgm extension is created by hand in the migration (Drizzle does not manage it).
    index("questions_search_trgm").using("gin", t.searchText.op("gin_trgm_ops")),
    index("questions_owner_deleted_banked_idx").on(t.ownerId, t.deletedAt, t.bankedAt),
    foreignKey({
      name: "questions_generation_request_owner_fk",
      columns: [t.generationRequestId, t.ownerId],
      foreignColumns: [generationRequests.id, generationRequests.ownerId],
    }),
    ownerSelectPolicy("questions", t),
    ownerUpdatePolicy("questions", t),
  ],
);

export const questionVersions = pgTable.withRLS(
  "question_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: ownerId(),
    questionId: uuid("question_id").notNull(),
    versionNo: integer("version_no").notNull(),
    author: text("author").notNull(),
    changeKind: text("change_kind").notNull(),
    // The difficulty this version was written for; restoring a version brings it back.
    difficulty: text("difficulty").notNull(),
    stemMd: text("stem_md").notNull(),
    options: jsonb("options").notNull(),
    answer: jsonb("answer").notNull(),
    explanationMd: text("explanation_md").notNull(),
    steps: jsonb("steps").notNull(),
    answerRules: jsonb("answer_rules"),
    verificationClaims: jsonb("verification_claims").notNull(),
    verificationStatus: text("verification_status").notNull(),
    teacherOverride: jsonb("teacher_override"),
    generationRunId: uuid("generation_run_id"),
    createdAt: createdAt(),
  },
  (t) => [
    check("question_versions_author_check", sql`${t.author} in ('ai', 'teacher')`),
    check(
      "question_versions_change_kind_check",
      sql`${t.changeKind} in ('generated', 'edited', 'regenerated', 'restored')`,
    ),
    check(
      "question_versions_difficulty_check",
      sql`${t.difficulty} in ('mudah', 'sedang', 'sulit')`,
    ),
    check(
      "question_versions_verification_status_check",
      sql.raw(`"verification_status" in (${VERIFICATION_STATUSES})`),
    ),
    unique("question_versions_id_owner_unique").on(t.id, t.ownerId),
    unique("question_versions_question_version_unique").on(t.questionId, t.versionNo),
    // Target of the assessment pins: a pinned version must belong to the pinned question.
    unique("question_versions_id_question_owner_unique").on(
      t.id,
      t.questionId,
      t.ownerId,
    ),
    foreignKey({
      name: "question_versions_question_owner_fk",
      columns: [t.questionId, t.ownerId],
      foreignColumns: [questions.id, questions.ownerId],
    }).onDelete("cascade"),
    foreignKey({
      name: "question_versions_run_owner_fk",
      columns: [t.generationRunId, t.ownerId],
      foreignColumns: [generationRuns.id, generationRuns.ownerId],
    }),
    ownerSelectPolicy("question_versions", t),
  ],
);

// A curriculum source (topic) or a material citation ("Sumber: <title>, hal. <n>"). The three
// material references exist only in the hand-edited migrations (Drizzle cannot express a column
// list on SET NULL): (material_id, owner_id), and (material_page_id | section_id, material_id,
// owner_id), so a cited page or section belongs to the cited material; each sets only its id
// column to null. The question_sources_clear_material_refs trigger clears the page and section
// when material_id becomes null (MATCH SIMPLE would otherwise leave them dangling). Deleting a
// material for good keeps the row, its anchor label and its excerpt, so the question keeps its
// content and shows "Materi sumber telah dihapus" (MAT-11); the purge may then clear the excerpt
// (decision 3).
export const questionSources = pgTable.withRLS(
  "question_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: ownerId(),
    questionVersionId: uuid("question_version_id").notNull(),
    kind: text("kind").notNull().default("curriculum"),
    topicId: uuid("topic_id").references(() => topics.id),
    materialId: uuid("material_id"),
    materialPageId: uuid("material_page_id"),
    sectionId: uuid("section_id"),
    anchorLabel: text("anchor_label"),
    excerpt: text("excerpt"),
    createdAt: createdAt(),
  },
  (t) => [
    check("question_sources_kind_check", sql`${t.kind} in ('curriculum', 'material')`),
    // A citation names its anchor ("hal. 5"), and quotes the passage while the material exists.
    check(
      "question_sources_material_anchor_check",
      sql`${t.kind} <> 'material' or (${t.anchorLabel} is not null and (${t.materialId} is null or ${t.excerpt} is not null))`,
    ),
    check(
      "question_sources_material_pair_check",
      sql`${t.materialId} is not null or (${t.materialPageId} is null and ${t.sectionId} is null)`,
    ),
    check(
      "question_sources_curriculum_no_material_check",
      sql`${t.kind} = 'material' or (${t.materialId} is null and ${t.materialPageId} is null and ${t.sectionId} is null)`,
    ),
    foreignKey({
      name: "question_sources_version_owner_fk",
      columns: [t.questionVersionId, t.ownerId],
      foreignColumns: [questionVersions.id, questionVersions.ownerId],
    }).onDelete("cascade"),
    index("question_sources_material_idx").on(t.materialId),
    index("question_sources_page_idx").on(t.materialPageId),
    index("question_sources_section_idx").on(t.sectionId),
    ownerSelectPolicy("question_sources", t),
  ],
);

export const verificationRuns = pgTable.withRLS(
  "verification_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: ownerId(),
    questionVersionId: uuid("question_version_id").notNull(),
    verifierVersion: text("verifier_version").notNull(),
    status: text("status").notNull(),
    checks: jsonb("checks")
      .notNull()
      .default(sql`'[]'::jsonb`),
    crossCheck: jsonb("cross_check"),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "verification_runs_status_check",
      sql.raw(`"status" in (${VERIFICATION_STATUSES})`),
    ),
    foreignKey({
      name: "verification_runs_version_owner_fk",
      columns: [t.questionVersionId, t.ownerId],
      foreignColumns: [questionVersions.id, questionVersions.ownerId],
    }).onDelete("cascade"),
    ownerSelectPolicy("verification_runs", t),
  ],
);
