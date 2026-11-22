-- Edited by hand (Task 3 of the materials plan): material_uploads holds the uploads startUpload
-- signed and finalise has not consumed (the finalise allow-list and the storage-cap reservation).
-- Written by the server only (service connection); the teacher may read their own rows.
CREATE TABLE "material_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" uuid NOT NULL,
	"object_key" text NOT NULL CONSTRAINT "material_uploads_object_key_unique" UNIQUE,
	"kind" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "material_uploads_kind_check" CHECK ("kind" in ('pdf', 'docx', 'image')),
	CONSTRAINT "material_uploads_size_check" CHECK ("size_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "material_uploads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "material_uploads_owner_expires_idx" ON "material_uploads" ("owner_id","expires_at");--> statement-breakpoint
ALTER TABLE "material_uploads" ADD CONSTRAINT "material_uploads_owner_id_profiles_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "material_uploads_owner_select" ON "material_uploads" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("material_uploads"."owner_id" = auth.uid());--> statement-breakpoint
GRANT SELECT ON "material_uploads" TO authenticated;