-- Edited by hand (Task 2 review, Ruling R7 amended):
-- 1. A cited page or section belongs to the cited material: question_sources references them as
--    (material_page_id | section_id, material_id, owner_id), each ON DELETE SET NULL on its id
--    column only (Drizzle cannot express the column list), replacing the (id, owner_id) references
--    of 20261120105530. With MATCH SIMPLE, once material_id is null the triple reference no longer
--    matches, so the question_sources_clear_material_refs trigger clears the page and section
--    whenever material_id becomes null (whichever foreign key action runs first when a material is
--    deleted for good). question_sources_material_pair_check keeps a page or section off a row
--    with no material.
-- 2. folders_one_level becomes SECURITY DEFINER: the teacher's update policy now hides trashed
--    folders, and the trigger's FOR SHARE lookup of the parent and its children search must still
--    see them (both filter by the row's owner_id). search_path stays empty.
-- 3. The update policies of folders and materials refuse trashed rows; non-empty checks on folder
--    names, material and section titles and solver method labels.
ALTER TABLE "material_pages" ADD CONSTRAINT "material_pages_id_material_owner_unique" UNIQUE("id","material_id","owner_id");--> statement-breakpoint
ALTER TABLE "question_sources" ADD CONSTRAINT "question_sources_material_pair_check" CHECK ("material_id" is not null or ("material_page_id" is null and "section_id" is null));--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_name_check" CHECK (btrim("name") <> '');--> statement-breakpoint
ALTER TABLE "material_sections" ADD CONSTRAINT "material_sections_title_check" CHECK (btrim("title") <> '');--> statement-breakpoint
ALTER TABLE "materials" ADD CONSTRAINT "materials_title_check" CHECK (btrim("title") <> '');--> statement-breakpoint
ALTER TABLE "solver_solutions" ADD CONSTRAINT "solver_solutions_method_label_check" CHECK (btrim("method_label") <> '');--> statement-breakpoint
ALTER POLICY "folders_owner_update" ON "folders" TO "authenticated" USING ("folders"."owner_id" = auth.uid() and "folders"."deleted_at" is null) WITH CHECK ("folders"."owner_id" = auth.uid() and "folders"."deleted_at" is null);--> statement-breakpoint
ALTER POLICY "materials_owner_update" ON "materials" TO "authenticated" USING ("materials"."owner_id" = auth.uid() and "materials"."deleted_at" is null) WITH CHECK ("materials"."owner_id" = auth.uid() and "materials"."deleted_at" is null);--> statement-breakpoint
ALTER TABLE "question_sources" DROP CONSTRAINT "question_sources_page_owner_fk";--> statement-breakpoint
ALTER TABLE "question_sources" DROP CONSTRAINT "question_sources_section_owner_fk";--> statement-breakpoint
ALTER TABLE "question_sources" ADD CONSTRAINT "question_sources_page_material_owner_fk" FOREIGN KEY ("material_page_id","material_id","owner_id") REFERENCES "material_pages"("id","material_id","owner_id") ON DELETE SET NULL ("material_page_id");--> statement-breakpoint
ALTER TABLE "question_sources" ADD CONSTRAINT "question_sources_section_material_owner_fk" FOREIGN KEY ("section_id","material_id","owner_id") REFERENCES "material_sections"("id","material_id","owner_id") ON DELETE SET NULL ("section_id");--> statement-breakpoint
CREATE FUNCTION "question_sources_clear_material_refs"() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.material_id IS NULL THEN
    NEW.material_page_id := NULL;
    NEW.section_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "question_sources_clear_material_refs"() FROM PUBLIC, authenticated;--> statement-breakpoint
CREATE TRIGGER "question_sources_clear_material_refs" BEFORE UPDATE OF "material_id" ON "question_sources" FOR EACH ROW EXECUTE FUNCTION "question_sources_clear_material_refs"();--> statement-breakpoint
ALTER FUNCTION "folders_one_level"() SECURITY DEFINER;