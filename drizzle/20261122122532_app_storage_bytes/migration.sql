-- Edited by hand (comment only). Expand-only: three columns that the app-wide 6 GB cap sums
-- (ADR-0022), written by the server only. Old code keeps working on the new schema (it never names
-- them; the defaults and nulls count as 0) and new code needs the columns, so apply this migration
-- BEFORE the new code serves traffic. Backfill: a stored logo (at most 1 MB) and a kept solver
-- photo (at most 2.5 MB) get their maximum, so the total never under-counts them (the real size
-- is unknown here; a replaced logo and a swept photo correct themselves). Exports keep 0: they
-- expire after 7 days, and the real bucket total is compared with the tracked one by the owner
-- monthly (runbook); the 6 GB cap leaves 4 GB of headroom.
-- The insert policy of school_templates now also requires logo_bytes to be null, so a teacher
-- cannot insert a row claiming an arbitrary size (INSERT is a table-wide grant; no UPDATE grant
-- names the new columns).
ALTER TABLE "exports" ADD COLUMN "size_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "school_templates" ADD COLUMN "logo_bytes" integer;--> statement-breakpoint
ALTER TABLE "solver_sessions" ADD COLUMN "input_bytes" integer;--> statement-breakpoint
UPDATE "school_templates" SET "logo_bytes" = 1048576 WHERE "logo_key" IS NOT NULL;--> statement-breakpoint
UPDATE "solver_sessions" SET "input_bytes" = 2500000 WHERE "input_key" IS NOT NULL;--> statement-breakpoint
ALTER POLICY "school_templates_owner_insert" ON "school_templates" TO "authenticated" WITH CHECK ("school_templates"."owner_id" = auth.uid() and "school_templates"."logo_key" is null and "school_templates"."logo_sha256" is null and "school_templates"."logo_bytes" is null and "school_templates"."deleted_at" is null and "school_templates"."purge_after" is null);