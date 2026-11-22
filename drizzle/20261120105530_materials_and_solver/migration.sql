-- Edited by hand (Task 2 of the materials plan):
-- 1. Foreign keys Drizzle cannot express (a column list on SET NULL keeps owner_id):
--    materials_folder_owner_fk (deleting a folder for good moves its materials to the top level)
--    and the three material references of question_sources (deleting a material for good keeps
--    the citation, its anchor label and excerpt, and the question's content, MAT-11).
-- 2. The folders_one_level trigger: a folder's parent has no parent, and a folder with children
--    gets none. It locks the parent row (FOR SHARE) so two concurrent moves cannot build a second
--    level: the later one waits for the earlier and then sees its result.
-- 3. Grants (tables are deny-by-default for authenticated). The teacher, through runAsUser:
--    folders: insert (the policy refuses trash dates), update of name and parent_id; no delete
--    (the trash, on the service connection). materials: update of title, folder_id, grade and
--    academic_year only; finalise inserts on the service connection and object_key, sha256, mime,
--    size, page_count, status, the proposal and its confirmation, and trash dates are server-only.
--    material_sections: every verb (the structure editor), update of everything but ids, owner,
--    material and created_at. material_pages, ocr_usage, solver_sessions and solver_solutions are
--    written by the jobs and the server actions on the service connection: select only.
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"purge_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folders_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "folders_not_own_parent_check" CHECK ("parent_id" <> "id")
);
--> statement-breakpoint
ALTER TABLE "folders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "material_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"page_no" integer NOT NULL,
	"text_md" text DEFAULT '' NOT NULL,
	"text_source" text,
	"confidence" text DEFAULT 'low' NOT NULL,
	"flags" jsonb DEFAULT '[]' NOT NULL,
	"ocr_status" text DEFAULT 'none' NOT NULL,
	"reviewed_at" timestamp with time zone,
	"tsv" tsvector GENERATED ALWAYS AS (to_tsvector('indonesian'::regconfig, "text_md")) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "material_pages_material_page_unique" UNIQUE("material_id","page_no"),
	CONSTRAINT "material_pages_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "material_pages_text_source_check" CHECK ("text_source" in ('pdf_text', 'docx', 'ocr', 'manual')),
	CONSTRAINT "material_pages_confidence_check" CHECK ("confidence" in ('high', 'medium', 'low')),
	CONSTRAINT "material_pages_ocr_status_check" CHECK ("ocr_status" in ('none', 'available', 'queued', 'done', 'failed')),
	CONSTRAINT "material_pages_flags_check" CHECK (jsonb_typeof("flags") = 'array'),
	CONSTRAINT "material_pages_page_no_check" CHECK ("page_no" >= 1)
);
--> statement-breakpoint
ALTER TABLE "material_pages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "material_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"parent_id" uuid,
	"title" text NOT NULL,
	"kind" text DEFAULT 'chapter' NOT NULL,
	"page_start" integer NOT NULL,
	"page_end" integer,
	"topic_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "material_sections_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "material_sections_id_material_owner_unique" UNIQUE("id","material_id","owner_id"),
	CONSTRAINT "material_sections_kind_check" CHECK ("kind" in ('chapter', 'section')),
	CONSTRAINT "material_sections_pages_check" CHECK ("page_start" >= 1 and ("page_end" is null or "page_end" >= "page_start")),
	CONSTRAINT "material_sections_not_own_parent_check" CHECK ("parent_id" <> "id")
);
--> statement-breakpoint
ALTER TABLE "material_sections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" uuid NOT NULL,
	"folder_id" uuid,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"object_key" text NOT NULL CONSTRAINT "materials_object_key_unique" UNIQUE,
	"page_count" integer,
	"grade" smallint,
	"academic_year" text,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"proposed_metadata" jsonb,
	"metadata_confirmed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"purge_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "materials_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "materials_kind_check" CHECK ("kind" in ('pdf', 'docx', 'image')),
	CONSTRAINT "materials_status_check" CHECK ("status" in ('uploaded', 'processing', 'needs_review', 'ready', 'failed')),
	CONSTRAINT "materials_grade_check" CHECK ("grade" in (7, 8, 9)),
	CONSTRAINT "materials_academic_year_check" CHECK ("academic_year" ~ '^[0-9]{4}/[0-9]{4}$'),
	CONSTRAINT "materials_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "materials_size_check" CHECK ("size_bytes" > 0),
	CONSTRAINT "materials_page_count_check" CHECK ("page_count" > 0)
);
--> statement-breakpoint
ALTER TABLE "materials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ocr_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" uuid NOT NULL,
	"day" date NOT NULL,
	"pages" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ocr_usage_owner_day_unique" UNIQUE("owner_id","day"),
	CONSTRAINT "ocr_usage_pages_check" CHECK ("pages" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ocr_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "solver_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" uuid NOT NULL,
	"input_kind" text NOT NULL,
	"input_text" text,
	"input_key" text,
	"extracted_md" text,
	"extraction_flags" jsonb DEFAULT '[]' NOT NULL,
	"confirmed_md" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"deleted_at" timestamp with time zone,
	"purge_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "solver_sessions_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "solver_sessions_input_kind_check" CHECK ("input_kind" in ('text', 'photo', 'file')),
	CONSTRAINT "solver_sessions_text_input_check" CHECK ("input_kind" <> 'text' or "input_text" is not null),
	CONSTRAINT "solver_sessions_status_check" CHECK ("status" in ('pending', 'extracting', 'needs_confirmation', 'ready', 'solved', 'failed')),
	CONSTRAINT "solver_sessions_extraction_flags_check" CHECK (jsonb_typeof("extraction_flags") = 'array')
);
--> statement-breakpoint
ALTER TABLE "solver_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "solver_solutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"method_label" text NOT NULL,
	"is_alternative" boolean DEFAULT false NOT NULL,
	"steps" jsonb NOT NULL,
	"final_answer" jsonb NOT NULL,
	"verification_status" text NOT NULL,
	"verification_report" jsonb,
	"generation_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "solver_solutions_verification_status_check" CHECK ("verification_status" in ('terverifikasi', 'dicek_silang_ai', 'belum_dapat_diverifikasi', 'ketidaksesuaian'))
);
--> statement-breakpoint
ALTER TABLE "solver_solutions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "question_sources" ADD COLUMN "material_id" uuid;--> statement-breakpoint
ALTER TABLE "question_sources" ADD COLUMN "material_page_id" uuid;--> statement-breakpoint
ALTER TABLE "question_sources" ADD COLUMN "section_id" uuid;--> statement-breakpoint
CREATE INDEX "question_sources_material_idx" ON "question_sources" ("material_id");--> statement-breakpoint
CREATE INDEX "question_sources_page_idx" ON "question_sources" ("material_page_id");--> statement-breakpoint
CREATE INDEX "question_sources_section_idx" ON "question_sources" ("section_id");--> statement-breakpoint
CREATE INDEX "folders_owner_parent_idx" ON "folders" ("owner_id","parent_id");--> statement-breakpoint
CREATE INDEX "folders_owner_deleted_idx" ON "folders" ("owner_id","deleted_at");--> statement-breakpoint
CREATE INDEX "material_pages_tsv_idx" ON "material_pages" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "material_pages_text_trgm" ON "material_pages" USING gin ("text_md" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "material_sections_material_idx" ON "material_sections" ("material_id");--> statement-breakpoint
CREATE INDEX "material_sections_parent_idx" ON "material_sections" ("parent_id");--> statement-breakpoint
CREATE INDEX "materials_owner_deleted_idx" ON "materials" ("owner_id","deleted_at");--> statement-breakpoint
CREATE INDEX "materials_owner_folder_idx" ON "materials" ("owner_id","folder_id");--> statement-breakpoint
CREATE INDEX "solver_sessions_owner_recent_idx" ON "solver_sessions" ("owner_id","deleted_at","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "solver_sessions_photo_purge_idx" ON "solver_sessions" ("created_at") WHERE "input_key" is not null;--> statement-breakpoint
CREATE INDEX "solver_solutions_session_idx" ON "solver_solutions" ("session_id");--> statement-breakpoint
CREATE INDEX "solver_solutions_run_idx" ON "solver_solutions" ("generation_run_id");--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_owner_id_profiles_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_owner_fk" FOREIGN KEY ("parent_id","owner_id") REFERENCES "folders"("id","owner_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "material_pages" ADD CONSTRAINT "material_pages_owner_id_profiles_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "material_pages" ADD CONSTRAINT "material_pages_material_owner_fk" FOREIGN KEY ("material_id","owner_id") REFERENCES "materials"("id","owner_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "material_sections" ADD CONSTRAINT "material_sections_owner_id_profiles_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "material_sections" ADD CONSTRAINT "material_sections_topic_id_topics_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id");--> statement-breakpoint
ALTER TABLE "material_sections" ADD CONSTRAINT "material_sections_material_owner_fk" FOREIGN KEY ("material_id","owner_id") REFERENCES "materials"("id","owner_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "material_sections" ADD CONSTRAINT "material_sections_parent_owner_fk" FOREIGN KEY ("parent_id","material_id","owner_id") REFERENCES "material_sections"("id","material_id","owner_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "materials" ADD CONSTRAINT "materials_owner_id_profiles_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ocr_usage" ADD CONSTRAINT "ocr_usage_owner_id_profiles_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "solver_sessions" ADD CONSTRAINT "solver_sessions_owner_id_profiles_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "solver_solutions" ADD CONSTRAINT "solver_solutions_owner_id_profiles_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "solver_solutions" ADD CONSTRAINT "solver_solutions_session_owner_fk" FOREIGN KEY ("session_id","owner_id") REFERENCES "solver_sessions"("id","owner_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "solver_solutions" ADD CONSTRAINT "solver_solutions_run_owner_fk" FOREIGN KEY ("generation_run_id","owner_id") REFERENCES "generation_runs"("id","owner_id");--> statement-breakpoint
ALTER TABLE "question_sources" ADD CONSTRAINT "question_sources_material_anchor_check" CHECK ("kind" <> 'material' or ("anchor_label" is not null and ("material_id" is null or "excerpt" is not null)));--> statement-breakpoint
ALTER TABLE "question_sources" ADD CONSTRAINT "question_sources_curriculum_no_material_check" CHECK ("kind" = 'material' or ("material_id" is null and "material_page_id" is null and "section_id" is null));--> statement-breakpoint
ALTER TABLE "question_sources" DROP CONSTRAINT "question_sources_kind_check", ADD CONSTRAINT "question_sources_kind_check" CHECK ("kind" in ('curriculum', 'material'));--> statement-breakpoint
CREATE POLICY "folders_owner_select" ON "folders" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("folders"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "folders_owner_insert" ON "folders" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("folders"."owner_id" = auth.uid() and "folders"."deleted_at" is null and "folders"."purge_after" is null);--> statement-breakpoint
CREATE POLICY "folders_owner_update" ON "folders" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("folders"."owner_id" = auth.uid()) WITH CHECK ("folders"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "material_pages_owner_select" ON "material_pages" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("material_pages"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "material_sections_owner_select" ON "material_sections" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("material_sections"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "material_sections_owner_insert" ON "material_sections" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("material_sections"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "material_sections_owner_update" ON "material_sections" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("material_sections"."owner_id" = auth.uid()) WITH CHECK ("material_sections"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "material_sections_owner_delete" ON "material_sections" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("material_sections"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "materials_owner_select" ON "materials" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("materials"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "materials_owner_update" ON "materials" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("materials"."owner_id" = auth.uid()) WITH CHECK ("materials"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "ocr_usage_owner_select" ON "ocr_usage" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("ocr_usage"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "solver_sessions_owner_select" ON "solver_sessions" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("solver_sessions"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "solver_solutions_owner_select" ON "solver_solutions" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("solver_solutions"."owner_id" = auth.uid());--> statement-breakpoint
ALTER TABLE "materials" ADD CONSTRAINT "materials_folder_owner_fk" FOREIGN KEY ("folder_id","owner_id") REFERENCES "folders"("id","owner_id") ON DELETE SET NULL ("folder_id");--> statement-breakpoint
ALTER TABLE "question_sources" ADD CONSTRAINT "question_sources_material_owner_fk" FOREIGN KEY ("material_id","owner_id") REFERENCES "materials"("id","owner_id") ON DELETE SET NULL ("material_id");--> statement-breakpoint
ALTER TABLE "question_sources" ADD CONSTRAINT "question_sources_page_owner_fk" FOREIGN KEY ("material_page_id","owner_id") REFERENCES "material_pages"("id","owner_id") ON DELETE SET NULL ("material_page_id");--> statement-breakpoint
ALTER TABLE "question_sources" ADD CONSTRAINT "question_sources_section_owner_fk" FOREIGN KEY ("section_id","owner_id") REFERENCES "material_sections"("id","owner_id") ON DELETE SET NULL ("section_id");--> statement-breakpoint
CREATE FUNCTION "folders_one_level"() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  grandparent uuid;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT f.parent_id INTO grandparent FROM public.folders f
    WHERE f.id = NEW.parent_id AND f.owner_id = NEW.owner_id FOR SHARE;
  IF grandparent IS NOT NULL THEN
    RAISE EXCEPTION 'folders_one_level: a folder cannot be placed inside a subfolder'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'folders_one_level';
  END IF;
  IF EXISTS (SELECT 1 FROM public.folders c WHERE c.owner_id = NEW.owner_id AND c.parent_id = NEW.id) THEN
    RAISE EXCEPTION 'folders_one_level: a folder with subfolders cannot be placed inside another folder'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'folders_one_level';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "folders_one_level"() FROM PUBLIC, authenticated;--> statement-breakpoint
CREATE TRIGGER "folders_one_level" BEFORE INSERT OR UPDATE OF "parent_id" ON "folders" FOR EACH ROW EXECUTE FUNCTION "folders_one_level"();--> statement-breakpoint
GRANT SELECT, INSERT ON "folders" TO authenticated;--> statement-breakpoint
GRANT UPDATE ("name", "parent_id", "updated_at") ON "folders" TO authenticated;--> statement-breakpoint
GRANT SELECT ON "materials" TO authenticated;--> statement-breakpoint
GRANT UPDATE ("title", "folder_id", "grade", "academic_year", "updated_at") ON "materials" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "material_sections" TO authenticated;--> statement-breakpoint
GRANT UPDATE ("parent_id", "title", "kind", "page_start", "page_end", "topic_id", "updated_at") ON "material_sections" TO authenticated;--> statement-breakpoint
GRANT SELECT ON "material_pages", "ocr_usage", "solver_sessions", "solver_solutions" TO authenticated;