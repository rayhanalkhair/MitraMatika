import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgPolicy,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import {
  createdAt,
  ownerDeletePolicy,
  ownerId,
  ownerInsertPolicy,
  ownerSelectPolicy,
  ownerUpdatePolicy,
  updatedAt,
} from "./columns";
import { authenticatedRole } from "./roles";
import { jobs } from "./platform";
import { questions, questionVersions } from "./questions";

// Ruling R1: school_templates, assessments, assessment_sections and assessment_items are written by
// the teacher through runAsUser, so each has owner policies for every verb (USING and WITH CHECK on
// owner_id). exports and question_usages are written by the export job through the service
// connection: the teacher may only read them. Grants (column-level UPDATE) are in the migration.
const ownerPolicies = (name: string, t: { ownerId: AnyPgColumn }) => [
  ownerSelectPolicy(name, t),
  ownerInsertPolicy(name, t),
  ownerUpdatePolicy(name, t),
  ownerDeletePolicy(name, t),
];

export const schoolTemplates = pgTable.withRLS(
  "school_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: ownerId(),
    name: text("name").notNull(),
    schoolName: text("school_name").notNull(),
    headerLines: jsonb("header_lines")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Object-store key of the uploaded logo (R2), never a URL.
    logoKey: text("logo_key"),
    // sha-256 (hex) of the stored logo's bytes, written with logo_key by the upload path only. The
    // approval hash covers it (Ruling R26): a same-format replacement keeps the key. Null for a
    // template without a logo, and for a logo uploaded before the column existed.
    logoSha256: text("logo_sha256"),
    // Bytes of the stored logo (at most 1 MB), written with logo_key by the upload path only; the
    // app-wide storage total sums it (ADR-0022). Null for a template without a logo and for a logo
    // stored before the column existed (counted as 0).
    logoBytes: integer("logo_bytes"),
    subject: text("subject").notNull().default("Matematika"),
    studentFields: jsonb("student_fields")
      .notNull()
      .default(sql`'[]'::jsonb`),
    defaultInstructionsMd: text("default_instructions_md"),
    paperSize: text("paper_size").notNull().default("A4"),
    font: text("font").notNull().default("times"),
    isDefault: boolean("is_default").notNull().default(false),
    rowVersion: integer("row_version").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    purgeAfter: timestamp("purge_after", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("school_templates_paper_size_check", sql`${t.paperSize} in ('A4', 'F4')`),
    check("school_templates_font_check", sql`${t.font} in ('times', 'arial')`),
    unique("school_templates_id_owner_unique").on(t.id, t.ownerId),
    // At most one default template per teacher; a trashed one does not count.
    uniqueIndex("school_templates_one_default_per_owner")
      .on(t.ownerId)
      .where(sql`${t.isDefault} and ${t.deletedAt} is null`),
    index("school_templates_owner_deleted_idx").on(t.ownerId, t.deletedAt),
    ownerSelectPolicy("school_templates", t),
    // A teacher never sets logo_key or logo_sha256: only the server upload path writes them
    // (service connection, explicit owner filters); nor trash dates, which only the trash writes.
    // The UPDATE grants on those columns are revoked (no grant for logo_sha256).
    pgPolicy("school_templates_owner_insert", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${t.ownerId} = auth.uid() and ${t.logoKey} is null and ${t.logoSha256} is null and ${t.logoBytes} is null and ${t.deletedAt} is null and ${t.purgeAfter} is null`,
    }),
    ownerUpdatePolicy("school_templates", t),
    ownerDeletePolicy("school_templates", t),
  ],
);

export const assessments = pgTable.withRLS(
  "assessments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: ownerId(),
    title: text("title").notNull(),
    kind: text("kind").notNull().default("latihan"),
    grade: smallint("grade").notNull(),
    templateId: uuid("template_id"),
    examDate: date("exam_date"),
    durationMinutes: integer("duration_minutes"),
    instructionsMd: text("instructions_md"),
    scoringMode: text("scoring_mode").notNull().default("equal"),
    // Null: no shuffling. Otherwise the stored seed of the deterministic shuffle.
    shuffleSeed: integer("shuffle_seed"),
    status: text("status").notNull().default("draft"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedSnapshotHash: text("approved_snapshot_hash"),
    rowVersion: integer("row_version").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    purgeAfter: timestamp("purge_after", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "assessments_kind_check",
      sql`${t.kind} in ('latihan', 'ulangan_harian', 'sts', 'sas', 'custom')`,
    ),
    check("assessments_grade_check", sql`${t.grade} in (7, 8, 9)`),
    check(
      "assessments_scoring_mode_check",
      sql`${t.scoringMode} in ('equal', 'manual', 'normalised')`,
    ),
    check("assessments_status_check", sql`${t.status} in ('draft', 'approved')`),
    check(
      "assessments_duration_check",
      sql`${t.durationMinutes} is null or ${t.durationMinutes} > 0`,
    ),
    check(
      "assessments_approved_check",
      sql`${t.status} <> 'approved' or (${t.approvedAt} is not null and ${t.approvedSnapshotHash} is not null)`,
    ),
    unique("assessments_id_owner_unique").on(t.id, t.ownerId),
    // No cascade: a template in use cannot be purged out from under an assessment (MATCH SIMPLE:
    // a null template_id is not checked).
    foreignKey({
      name: "assessments_template_owner_fk",
      columns: [t.templateId, t.ownerId],
      foreignColumns: [schoolTemplates.id, schoolTemplates.ownerId],
    }),
    index("assessments_owner_deleted_idx").on(t.ownerId, t.deletedAt),
    index("assessments_template_idx").on(t.templateId),
    ownerSelectPolicy("assessments", t),
    // Trash dates are written only by the trash (service connection): a row inserted already
    // trashed without purge_after would be hidden from the list and the trash and never purged.
    pgPolicy("assessments_owner_insert", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${t.ownerId} = auth.uid() and ${t.deletedAt} is null and ${t.purgeAfter} is null`,
    }),
    ownerUpdatePolicy("assessments", t),
    ownerDeletePolicy("assessments", t),
  ],
);

export const assessmentSections = pgTable.withRLS(
  "assessment_sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: ownerId(),
    assessmentId: uuid("assessment_id").notNull(),
    title: text("title").notNull(),
    instructionsMd: text("instructions_md"),
    sortOrder: integer("sort_order").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("assessment_sections_id_assessment_owner_unique").on(
      t.id,
      t.assessmentId,
      t.ownerId,
    ),
    foreignKey({
      name: "assessment_sections_assessment_owner_fk",
      columns: [t.assessmentId, t.ownerId],
      foreignColumns: [assessments.id, assessments.ownerId],
    }).onDelete("cascade"),
    index("assessment_sections_assessment_idx").on(t.assessmentId),
    ...ownerPolicies("assessment_sections", t),
  ],
);

// An item pins one version of a question (Ruling R2). The pin and the question reference are NO
// ACTION, never cascade: deleting a pinned question (purge or delete permanently) fails with a
// foreign key violation (23503) instead of silently emptying the assessment. Callers detect the pin
// first with `exists (select 1 from assessment_items where question_id = $1)` (indexed) and skip or
// refuse; the constraint is the backstop. Deleting the assessment (or the account) takes the items.
export const assessmentItems = pgTable.withRLS(
  "assessment_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: ownerId(),
    assessmentId: uuid("assessment_id").notNull(),
    sectionId: uuid("section_id").notNull(),
    questionId: uuid("question_id").notNull(),
    questionVersionId: uuid("question_version_id").notNull(),
    sortOrder: integer("sort_order").notNull(),
    points: numeric("points", { precision: 6, scale: 2 }).notNull().default("0"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("assessment_items_points_check", sql`${t.points} >= 0`),
    // A question appears at most once in an assessment.
    unique("assessment_items_question_once").on(t.assessmentId, t.questionId),
    foreignKey({
      name: "assessment_items_assessment_owner_fk",
      columns: [t.assessmentId, t.ownerId],
      foreignColumns: [assessments.id, assessments.ownerId],
    }).onDelete("cascade"),
    // The section belongs to the same assessment and owner.
    foreignKey({
      name: "assessment_items_section_owner_fk",
      columns: [t.sectionId, t.assessmentId, t.ownerId],
      foreignColumns: [
        assessmentSections.id,
        assessmentSections.assessmentId,
        assessmentSections.ownerId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "assessment_items_question_owner_fk",
      columns: [t.questionId, t.ownerId],
      foreignColumns: [questions.id, questions.ownerId],
    }),
    // The pinned version belongs to the item's question and owner.
    foreignKey({
      name: "assessment_items_version_owner_fk",
      columns: [t.questionVersionId, t.questionId, t.ownerId],
      foreignColumns: [
        questionVersions.id,
        questionVersions.questionId,
        questionVersions.ownerId,
      ],
    }),
    index("assessment_items_section_idx").on(t.sectionId),
    index("assessment_items_question_idx").on(t.questionId),
    index("assessment_items_version_idx").on(t.questionVersionId),
    ...ownerPolicies("assessment_items", t),
  ],
);

// One row per rendered file of an export run. Written by the export job (service connection).
export const exports = pgTable.withRLS(
  "exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: ownerId(),
    assessmentId: uuid("assessment_id").notNull(),
    document: text("document").notNull(),
    format: text("format").notNull(),
    objectKey: text("object_key").notNull(),
    // Real byte length of the stored file, written by the export job (ADR-0022: the app-wide
    // storage total sums it). 0 for a row stored before the column existed.
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    snapshotHash: text("snapshot_hash").notNull(),
    // Formulas the DOCX renderer had to fall back to plain text for, and the like.
    warnings: jsonb("warnings")
      .notNull()
      .default(sql`'[]'::jsonb`),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    jobId: uuid("job_id"),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "exports_document_check",
      sql`${t.document} in ('paper', 'key', 'solutions', 'zip')`,
    ),
    check("exports_format_check", sql`${t.format} in ('pdf', 'docx', 'zip')`),
    check(
      "exports_zip_format_check",
      sql`(${t.document} = 'zip') = (${t.format} = 'zip')`,
    ),
    unique("exports_id_owner_unique").on(t.id, t.ownerId),
    foreignKey({
      name: "exports_assessment_owner_fk",
      columns: [t.assessmentId, t.ownerId],
      foreignColumns: [assessments.id, assessments.ownerId],
    }).onDelete("cascade"),
    foreignKey({
      name: "exports_job_owner_fk",
      columns: [t.jobId, t.ownerId],
      foreignColumns: [jobs.id, jobs.ownerId],
    }),
    index("exports_assessment_idx").on(t.assessmentId),
    index("exports_job_idx").on(t.jobId),
    // The daily purge of expired exports.
    index("exports_expires_at_idx").on(t.expiresAt),
    ownerSelectPolicy("exports", t),
  ],
);

// Which question versions went out in which export (QB-04). Written by the export job. The
// reference to the export, (export_id, owner_id) ON DELETE SET NULL (export_id), exists only in the
// hand-edited migration (Drizzle cannot express a column list on SET NULL): the usage outlives the
// purge of its expired export row.
export const questionUsages = pgTable.withRLS(
  "question_usages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: ownerId(),
    questionId: uuid("question_id").notNull(),
    questionVersionId: uuid("question_version_id").notNull(),
    assessmentId: uuid("assessment_id").notNull(),
    exportId: uuid("export_id"),
    usedAt: timestamp("used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("question_usages_once_per_export").on(
      t.assessmentId,
      t.exportId,
      t.questionVersionId,
    ),
    foreignKey({
      name: "question_usages_question_owner_fk",
      columns: [t.questionId, t.ownerId],
      foreignColumns: [questions.id, questions.ownerId],
    }).onDelete("cascade"),
    foreignKey({
      name: "question_usages_version_owner_fk",
      columns: [t.questionVersionId, t.questionId, t.ownerId],
      foreignColumns: [
        questionVersions.id,
        questionVersions.questionId,
        questionVersions.ownerId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "question_usages_assessment_owner_fk",
      columns: [t.assessmentId, t.ownerId],
      foreignColumns: [assessments.id, assessments.ownerId],
    }).onDelete("cascade"),
    index("question_usages_question_idx").on(t.questionId),
    index("question_usages_version_idx").on(t.questionVersionId),
    index("question_usages_export_idx").on(t.exportId),
    ownerSelectPolicy("question_usages", t),
  ],
);
