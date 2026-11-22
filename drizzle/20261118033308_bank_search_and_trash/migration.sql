-- Edited by hand: pg_trgm for the search index, and the explicit grant (tables are deny-by-default).
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "deletion_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" uuid,
	"entity" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"counts" jsonb DEFAULT '{}' NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deletion_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "purge_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "search_text" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "questions_search_trgm" ON "questions" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "questions_owner_deleted_banked_idx" ON "questions" ("owner_id","deleted_at","banked_at");--> statement-breakpoint
ALTER TABLE "deletion_log" ADD CONSTRAINT "deletion_log_owner_id_profiles_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE POLICY "deletion_log_owner_select" ON "deletion_log" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("deletion_log"."owner_id" = auth.uid());--> statement-breakpoint
GRANT SELECT ON "deletion_log" TO authenticated;
