-- Edited by hand (comment only). Two server-only rules:
-- 1. logo_sha256: the sha-256 of the stored logo, written with logo_key by the upload path only
--    (service connection). The approval snapshot hash covers it (Ruling R26: the printed template
--    fields, not row_version). No UPDATE grant for authenticated (the column-level grants of
--    20261119102716 list their columns), and the insert policy requires it to be null. Logos
--    uploaded before this migration keep a null hash until they are replaced.
-- 2. The insert policies of assessments and school_templates refuse trash dates (deleted_at,
--    purge_after): a row inserted already trashed without purge_after would be hidden from the list
--    and the trash and never purged (the UPDATE side was closed in 20261120050000).
ALTER TABLE "school_templates" ADD COLUMN "logo_sha256" text;--> statement-breakpoint
ALTER POLICY "assessments_owner_insert" ON "assessments" TO "authenticated" WITH CHECK ("assessments"."owner_id" = auth.uid() and "assessments"."deleted_at" is null and "assessments"."purge_after" is null);--> statement-breakpoint
ALTER POLICY "school_templates_owner_insert" ON "school_templates" TO "authenticated" WITH CHECK ("school_templates"."owner_id" = auth.uid() and "school_templates"."logo_key" is null and "school_templates"."logo_sha256" is null and "school_templates"."deleted_at" is null and "school_templates"."purge_after" is null);