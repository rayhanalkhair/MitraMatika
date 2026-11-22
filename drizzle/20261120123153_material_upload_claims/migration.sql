ALTER TABLE "material_uploads" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "material_uploads" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "material_uploads" ADD CONSTRAINT "material_uploads_claim_check" CHECK (("claim_token" is null) = ("claimed_at" is null));