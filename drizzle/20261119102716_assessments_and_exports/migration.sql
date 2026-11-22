-- Edited by hand: the grants (tables are deny-by-default for authenticated; Ruling R1: the teacher
-- writes templates, assessments, sections and items through runAsUser, column-level UPDATE leaves
-- id, owner_id and created_at out; exports and question_usages are written by the export job and
-- only readable), and question_usages_export_owner_fk, which Drizzle cannot express (SET NULL on
-- export_id only: the usage keeps its owner when the expired export row is purged).
CREATE TABLE "assessment_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" uuid NOT NULL,
	"assessment_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"question_version_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"points" numeric(6,2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_items_question_once" UNIQUE("assessment_id","question_id"),
	CONSTRAINT "assessment_items_points_check" CHECK ("points" >= 0)
);
--> statement-breakpoint
ALTER TABLE "assessment_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "assessment_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" uuid NOT NULL,
	"assessment_id" uuid NOT NULL,
	"title" text NOT NULL,
	"instructions_md" text,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_sections_id_assessment_owner_unique" UNIQUE("id","assessment_id","owner_id")
);
--> statement-breakpoint
ALTER TABLE "assessment_sections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"kind" text DEFAULT 'latihan' NOT NULL,
	"grade" smallint NOT NULL,
	"template_id" uuid,
	"exam_date" date,
	"duration_minutes" integer,
	"instructions_md" text,
	"scoring_mode" text DEFAULT 'equal' NOT NULL,
	"shuffle_seed" integer,
	"status" text DEFAULT 'draft' NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_snapshot_hash" text,
	"row_version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"purge_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessments_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "assessments_kind_check" CHECK ("kind" in ('latihan', 'ulangan_harian', 'sts', 'sas', 'custom')),
	CONSTRAINT "assessments_grade_check" CHECK ("grade" in (7, 8, 9)),
	CONSTRAINT "assessments_scoring_mode_check" CHECK ("scoring_mode" in ('equal', 'manual', 'normalised')),
	CONSTRAINT "assessments_status_check" CHECK ("status" in ('draft', 'approved')),
	CONSTRAINT "assessments_duration_check" CHECK ("duration_minutes" is null or "duration_minutes" > 0),
	CONSTRAINT "assessments_approved_check" CHECK ("status" <> 'approved' or ("approved_at" is not null and "approved_snapshot_hash" is not null))
);
--> statement-breakpoint
ALTER TABLE "assessments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" uuid NOT NULL,
	"assessment_id" uuid NOT NULL,
	"document" text NOT NULL,
	"format" text NOT NULL,
	"object_key" text NOT NULL,
	"snapshot_hash" text NOT NULL,
	"warnings" jsonb DEFAULT '[]' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exports_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "exports_document_check" CHECK ("document" in ('paper', 'key', 'solutions', 'zip')),
	CONSTRAINT "exports_format_check" CHECK ("format" in ('pdf', 'docx', 'zip')),
	CONSTRAINT "exports_zip_format_check" CHECK (("document" = 'zip') = ("format" = 'zip'))
);
--> statement-breakpoint
ALTER TABLE "exports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "question_usages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"question_version_id" uuid NOT NULL,
	"assessment_id" uuid NOT NULL,
	"export_id" uuid,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_usages_once_per_export" UNIQUE("assessment_id","export_id","question_version_id")
);
--> statement-breakpoint
ALTER TABLE "question_usages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "school_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"school_name" text NOT NULL,
	"header_lines" jsonb DEFAULT '[]' NOT NULL,
	"logo_key" text,
	"subject" text DEFAULT 'Matematika' NOT NULL,
	"student_fields" jsonb DEFAULT '[]' NOT NULL,
	"default_instructions_md" text,
	"paper_size" text DEFAULT 'A4' NOT NULL,
	"font" text DEFAULT 'times' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"purge_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "school_templates_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "school_templates_paper_size_check" CHECK ("paper_size" in ('A4', 'F4')),
	CONSTRAINT "school_templates_font_check" CHECK ("font" in ('times', 'arial'))
);
--> statement-breakpoint
ALTER TABLE "school_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_id_question_owner_unique" UNIQUE("id","question_id","owner_id");--> statement-breakpoint
CREATE INDEX "assessment_items_section_idx" ON "assessment_items" ("section_id");--> statement-breakpoint
CREATE INDEX "assessment_items_question_idx" ON "assessment_items" ("question_id");--> statement-breakpoint
CREATE INDEX "assessment_items_version_idx" ON "assessment_items" ("question_version_id");--> statement-breakpoint
CREATE INDEX "assessment_sections_assessment_idx" ON "assessment_sections" ("assessment_id");--> statement-breakpoint
CREATE INDEX "assessments_owner_deleted_idx" ON "assessments" ("owner_id","deleted_at");--> statement-breakpoint
CREATE INDEX "assessments_template_idx" ON "assessments" ("template_id");--> statement-breakpoint
CREATE INDEX "exports_assessment_idx" ON "exports" ("assessment_id");--> statement-breakpoint
CREATE INDEX "exports_job_idx" ON "exports" ("job_id");--> statement-breakpoint
CREATE INDEX "exports_expires_at_idx" ON "exports" ("expires_at");--> statement-breakpoint
CREATE INDEX "question_usages_question_idx" ON "question_usages" ("question_id");--> statement-breakpoint
CREATE INDEX "question_usages_version_idx" ON "question_usages" ("question_version_id");--> statement-breakpoint
CREATE INDEX "question_usages_export_idx" ON "question_usages" ("export_id");--> statement-breakpoint
CREATE UNIQUE INDEX "school_templates_one_default_per_owner" ON "school_templates" ("owner_id") WHERE "is_default" and "deleted_at" is null;--> statement-breakpoint
CREATE INDEX "school_templates_owner_deleted_idx" ON "school_templates" ("owner_id","deleted_at");--> statement-breakpoint
ALTER TABLE "assessment_items" ADD CONSTRAINT "assessment_items_owner_id_profiles_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assessment_items" ADD CONSTRAINT "assessment_items_assessment_owner_fk" FOREIGN KEY ("assessment_id","owner_id") REFERENCES "assessments"("id","owner_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assessment_items" ADD CONSTRAINT "assessment_items_section_owner_fk" FOREIGN KEY ("section_id","assessment_id","owner_id") REFERENCES "assessment_sections"("id","assessment_id","owner_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assessment_items" ADD CONSTRAINT "assessment_items_question_owner_fk" FOREIGN KEY ("question_id","owner_id") REFERENCES "questions"("id","owner_id");--> statement-breakpoint
ALTER TABLE "assessment_items" ADD CONSTRAINT "assessment_items_version_owner_fk" FOREIGN KEY ("question_version_id","question_id","owner_id") REFERENCES "question_versions"("id","question_id","owner_id");--> statement-breakpoint
ALTER TABLE "assessment_sections" ADD CONSTRAINT "assessment_sections_owner_id_profiles_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assessment_sections" ADD CONSTRAINT "assessment_sections_assessment_owner_fk" FOREIGN KEY ("assessment_id","owner_id") REFERENCES "assessments"("id","owner_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_owner_id_profiles_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_template_owner_fk" FOREIGN KEY ("template_id","owner_id") REFERENCES "school_templates"("id","owner_id");--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_owner_id_profiles_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_assessment_owner_fk" FOREIGN KEY ("assessment_id","owner_id") REFERENCES "assessments"("id","owner_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_job_owner_fk" FOREIGN KEY ("job_id","owner_id") REFERENCES "jobs"("id","owner_id");--> statement-breakpoint
ALTER TABLE "question_usages" ADD CONSTRAINT "question_usages_owner_id_profiles_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_usages" ADD CONSTRAINT "question_usages_question_owner_fk" FOREIGN KEY ("question_id","owner_id") REFERENCES "questions"("id","owner_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_usages" ADD CONSTRAINT "question_usages_version_owner_fk" FOREIGN KEY ("question_version_id","question_id","owner_id") REFERENCES "question_versions"("id","question_id","owner_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_usages" ADD CONSTRAINT "question_usages_assessment_owner_fk" FOREIGN KEY ("assessment_id","owner_id") REFERENCES "assessments"("id","owner_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "school_templates" ADD CONSTRAINT "school_templates_owner_id_profiles_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "assessment_items_owner_select" ON "assessment_items" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("assessment_items"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "assessment_items_owner_insert" ON "assessment_items" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("assessment_items"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "assessment_items_owner_update" ON "assessment_items" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("assessment_items"."owner_id" = auth.uid()) WITH CHECK ("assessment_items"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "assessment_items_owner_delete" ON "assessment_items" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("assessment_items"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "assessment_sections_owner_select" ON "assessment_sections" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("assessment_sections"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "assessment_sections_owner_insert" ON "assessment_sections" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("assessment_sections"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "assessment_sections_owner_update" ON "assessment_sections" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("assessment_sections"."owner_id" = auth.uid()) WITH CHECK ("assessment_sections"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "assessment_sections_owner_delete" ON "assessment_sections" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("assessment_sections"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "assessments_owner_select" ON "assessments" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("assessments"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "assessments_owner_insert" ON "assessments" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("assessments"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "assessments_owner_update" ON "assessments" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("assessments"."owner_id" = auth.uid()) WITH CHECK ("assessments"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "assessments_owner_delete" ON "assessments" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("assessments"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "exports_owner_select" ON "exports" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("exports"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "question_usages_owner_select" ON "question_usages" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("question_usages"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "school_templates_owner_select" ON "school_templates" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("school_templates"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "school_templates_owner_insert" ON "school_templates" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("school_templates"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "school_templates_owner_update" ON "school_templates" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("school_templates"."owner_id" = auth.uid()) WITH CHECK ("school_templates"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "school_templates_owner_delete" ON "school_templates" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("school_templates"."owner_id" = auth.uid());--> statement-breakpoint
ALTER TABLE "question_usages" ADD CONSTRAINT "question_usages_export_owner_fk" FOREIGN KEY ("export_id","owner_id") REFERENCES "exports"("id","owner_id") ON DELETE SET NULL ("export_id");--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "school_templates", "assessments", "assessment_sections", "assessment_items" TO authenticated;--> statement-breakpoint
GRANT UPDATE ("name", "school_name", "header_lines", "logo_key", "subject", "student_fields", "default_instructions_md", "paper_size", "font", "is_default", "row_version", "deleted_at", "purge_after", "updated_at") ON "school_templates" TO authenticated;--> statement-breakpoint
GRANT UPDATE ("title", "kind", "grade", "template_id", "exam_date", "duration_minutes", "instructions_md", "scoring_mode", "shuffle_seed", "status", "approved_at", "approved_snapshot_hash", "row_version", "deleted_at", "purge_after", "updated_at") ON "assessments" TO authenticated;--> statement-breakpoint
GRANT UPDATE ("title", "instructions_md", "sort_order", "updated_at") ON "assessment_sections" TO authenticated;--> statement-breakpoint
GRANT UPDATE ("section_id", "question_version_id", "sort_order", "points", "updated_at") ON "assessment_items" TO authenticated;--> statement-breakpoint
GRANT SELECT ON "exports", "question_usages" TO authenticated;
