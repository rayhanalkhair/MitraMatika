import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
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
import { topics } from "./curriculum";
import { authenticatedRole } from "./roles";

// Who writes what (grants are column-level, in the migration):
// - folders: the teacher through runAsUser (create, rename, move); trash dates and hard deletes
//   belong to the trash on the service connection.
// - materials: created by finalise and changed by the ingestion job on the service connection
//   (object_key, sha256, mime, size, page_count, status, proposed metadata and its confirmation,
//   trash dates are server-only: a teacher could otherwise point object_key at another owner's
//   file). The teacher edits title, folder, grade and academic year through runAsUser.
// - material_sections: the teacher's structure editor through runAsUser (every verb).
// - material_pages and ocr_usage: written by the ingestion and OCR jobs and savePageText on the
//   service connection; the teacher only reads them.

const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});

// One level of nesting: a folder's parent has no parent, and a folder with children has none.
// The rule needs other rows, so it is a trigger (folders_one_level, hand-written in the migration).
export const folders = pgTable.withRLS(
  "folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: ownerId(),
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    purgeAfter: timestamp("purge_after", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("folders_not_own_parent_check", sql`${t.parentId} <> ${t.id}`),
    check("folders_name_check", sql`btrim(${t.name}) <> ''`),
    unique("folders_id_owner_unique").on(t.id, t.ownerId),
    // Deleting a folder for good takes its subfolders (their materials move to the top level).
    foreignKey({
      name: "folders_parent_owner_fk",
      columns: [t.parentId, t.ownerId],
      foreignColumns: [t.id, t.ownerId],
    }).onDelete("cascade"),
    index("folders_owner_parent_idx").on(t.ownerId, t.parentId),
    index("folders_owner_deleted_idx").on(t.ownerId, t.deletedAt),
    ownerSelectPolicy("folders", t),
    pgPolicy("folders_owner_insert", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${t.ownerId} = auth.uid() and ${t.deletedAt} is null and ${t.purgeAfter} is null`,
    }),
    // A trashed folder is not editable by the teacher (restore goes through the trash).
    pgPolicy("folders_owner_update", {
      for: "update",
      to: authenticatedRole,
      using: sql`${t.ownerId} = auth.uid() and ${t.deletedAt} is null`,
      withCheck: sql`${t.ownerId} = auth.uid() and ${t.deletedAt} is null`,
    }),
  ],
);

// The reference to the folder, (folder_id, owner_id) ON DELETE SET NULL (folder_id), exists only in
// the hand-edited migration (Drizzle cannot express a column list on SET NULL): deleting a folder
// for good moves its materials to the top level.
export const materials = pgTable.withRLS(
  "materials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: ownerId(),
    folderId: uuid("folder_id"),
    title: text("title").notNull(),
    kind: text("kind").notNull(),
    mime: text("mime").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    // sha-256 (hex) of the stored file's bytes, checked at finalise.
    sha256: text("sha256").notNull(),
    // Object-store key (R2), never a URL; built from ids only.
    objectKey: text("object_key").notNull(),
    // Null until ingestion has counted the pages.
    pageCount: integer("page_count"),
    grade: smallint("grade"),
    // "2026/2027".
    academicYear: text("academic_year"),
    status: text("status").notNull().default("uploaded"),
    // The structure proposal (title, grade, chapters with page ranges, topics), editable before
    // confirmation.
    proposedMetadata: jsonb("proposed_metadata"),
    metadataConfirmedAt: timestamp("metadata_confirmed_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    purgeAfter: timestamp("purge_after", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("materials_kind_check", sql`${t.kind} in ('pdf', 'docx', 'image')`),
    check("materials_title_check", sql`btrim(${t.title}) <> ''`),
    check(
      "materials_status_check",
      sql`${t.status} in ('uploaded', 'processing', 'needs_review', 'ready', 'failed')`,
    ),
    check("materials_grade_check", sql`${t.grade} in (7, 8, 9)`),
    check(
      "materials_academic_year_check",
      sql`${t.academicYear} ~ '^[0-9]{4}/[0-9]{4}$'`,
    ),
    check("materials_sha256_check", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check("materials_size_check", sql`${t.sizeBytes} > 0`),
    check("materials_page_count_check", sql`${t.pageCount} > 0`),
    unique("materials_id_owner_unique").on(t.id, t.ownerId),
    unique("materials_object_key_unique").on(t.objectKey),
    index("materials_owner_deleted_idx").on(t.ownerId, t.deletedAt),
    index("materials_owner_folder_idx").on(t.ownerId, t.folderId),
    ownerSelectPolicy("materials", t),
    // A trashed material is not editable by the teacher (restore goes through the trash).
    pgPolicy("materials_owner_update", {
      for: "update",
      to: authenticatedRole,
      using: sql`${t.ownerId} = auth.uid() and ${t.deletedAt} is null`,
      withCheck: sql`${t.ownerId} = auth.uid() and ${t.deletedAt} is null`,
    }),
  ],
);

export const materialSections = pgTable.withRLS(
  "material_sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: ownerId(),
    materialId: uuid("material_id").notNull(),
    // A chapter's subsection points at the chapter (same material).
    parentId: uuid("parent_id"),
    title: text("title").notNull(),
    kind: text("kind").notNull().default("chapter"),
    pageStart: integer("page_start").notNull(),
    pageEnd: integer("page_end"),
    topicId: uuid("topic_id").references(() => topics.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("material_sections_kind_check", sql`${t.kind} in ('chapter', 'section')`),
    check("material_sections_title_check", sql`btrim(${t.title}) <> ''`),
    check(
      "material_sections_pages_check",
      sql`${t.pageStart} >= 1 and (${t.pageEnd} is null or ${t.pageEnd} >= ${t.pageStart})`,
    ),
    check("material_sections_not_own_parent_check", sql`${t.parentId} <> ${t.id}`),
    unique("material_sections_id_owner_unique").on(t.id, t.ownerId),
    // Target of the parent reference and of question_sources.section_id (same material).
    unique("material_sections_id_material_owner_unique").on(
      t.id,
      t.materialId,
      t.ownerId,
    ),
    foreignKey({
      name: "material_sections_material_owner_fk",
      columns: [t.materialId, t.ownerId],
      foreignColumns: [materials.id, materials.ownerId],
    }).onDelete("cascade"),
    foreignKey({
      name: "material_sections_parent_owner_fk",
      columns: [t.parentId, t.materialId, t.ownerId],
      foreignColumns: [t.id, t.materialId, t.ownerId],
    }).onDelete("cascade"),
    index("material_sections_material_idx").on(t.materialId),
    index("material_sections_parent_idx").on(t.parentId),
    ownerSelectPolicy("material_sections", t),
    ownerInsertPolicy("material_sections", t),
    ownerUpdatePolicy("material_sections", t),
    ownerDeletePolicy("material_sections", t),
  ],
);

export const materialPages = pgTable.withRLS(
  "material_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: ownerId(),
    materialId: uuid("material_id").notNull(),
    pageNo: integer("page_no").notNull(),
    // Markdown with LaTeX; `[[?]]` marks uncertain OCR output.
    textMd: text("text_md").notNull().default(""),
    // Null while a page has no text yet (an image before OCR).
    textSource: text("text_source"),
    confidence: text("confidence").notNull().default("low"),
    flags: jsonb("flags")
      .notNull()
      .default(sql`'[]'::jsonb`),
    ocrStatus: text("ocr_status").notNull().default("none"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    // Bytes of the page image OCR keeps under materials/<owner>/<material>/pages/ (server-only);
    // they count toward the teacher's 300 MB storage cap.
    imageBytes: integer("image_bytes"),
    // Full-text search over the page (Indonesian stemming), kept in step with text_md by Postgres.
    tsv: tsvector("tsv")
      .notNull()
      .generatedAlwaysAs(sql`to_tsvector('indonesian'::regconfig, "text_md")`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "material_pages_text_source_check",
      sql`${t.textSource} in ('pdf_text', 'docx', 'ocr', 'manual')`,
    ),
    check(
      "material_pages_confidence_check",
      sql`${t.confidence} in ('high', 'medium', 'low')`,
    ),
    check(
      "material_pages_ocr_status_check",
      sql`${t.ocrStatus} in ('none', 'available', 'queued', 'done', 'failed')`,
    ),
    check("material_pages_flags_check", sql`jsonb_typeof(${t.flags}) = 'array'`),
    check("material_pages_page_no_check", sql`${t.pageNo} >= 1`),
    unique("material_pages_material_page_unique").on(t.materialId, t.pageNo),
    unique("material_pages_id_owner_unique").on(t.id, t.ownerId),
    // Target of question_sources.material_page_id (same material and owner).
    unique("material_pages_id_material_owner_unique").on(t.id, t.materialId, t.ownerId),
    foreignKey({
      name: "material_pages_material_owner_fk",
      columns: [t.materialId, t.ownerId],
      foreignColumns: [materials.id, materials.ownerId],
    }).onDelete("cascade"),
    index("material_pages_tsv_idx").using("gin", t.tsv),
    // The pg_trgm extension exists since 20261118033308.
    index("material_pages_text_trgm").using("gin", t.textMd.op("gin_trgm_ops")),
    ownerSelectPolicy("material_pages", t),
  ],
);

// An upload that startUpload signed and finalise has not consumed yet. Written by the server only
// (service connection): finalise accepts only a key that has a live row of the same owner, and the
// 300 MB storage cap counts these reservations next to the stored materials. A row past expires_at
// no longer counts and is swept (object and row) by the owner's next startUpload. The id is the
// future material's id, so the object key never changes.
export const materialUploads = pgTable.withRLS(
  "material_uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: ownerId(),
    objectKey: text("object_key").notNull(),
    kind: text("kind").notNull(),
    mime: text("mime").notNull(),
    // The exact size the PUT URL was signed for.
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Set by the finalise that is checking this upload (outside any transaction); another
    // finalise, a cancel or the sweep leaves a fresh claim alone. Cleared when the bytes have not
    // arrived yet.
    claimToken: uuid("claim_token"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    // Set when the teacher cancels. The row still counts toward the caps until expires_at (its
    // PUT URL may still be used) and can never be finalised; the sweep removes it after expiry.
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "material_uploads_claim_check",
      sql`(${t.claimToken} is null) = (${t.claimedAt} is null)`,
    ),
    check("material_uploads_kind_check", sql`${t.kind} in ('pdf', 'docx', 'image')`),
    check("material_uploads_size_check", sql`${t.sizeBytes} > 0`),
    unique("material_uploads_object_key_unique").on(t.objectKey),
    index("material_uploads_owner_expires_idx").on(t.ownerId, t.expiresAt),
    ownerSelectPolicy("material_uploads", t),
  ],
);

// Pages OCR'd per owner and Jakarta day (USER_DAILY_OCR_PAGES), counted by the OCR queue on the
// service connection under a lock.
export const ocrUsage = pgTable.withRLS(
  "ocr_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: ownerId(),
    day: date("day").notNull(),
    pages: integer("pages").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("ocr_usage_pages_check", sql`${t.pages} >= 0`),
    unique("ocr_usage_owner_day_unique").on(t.ownerId, t.day),
    ownerSelectPolicy("ocr_usage", t),
  ],
);
