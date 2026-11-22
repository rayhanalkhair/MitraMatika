-- Edited by hand: versions store their own difficulty (R13). The column is added nullable,
-- backfilled from the question (versions are immutable, so the no-update trigger is paused for the
-- backfill only), then made NOT NULL. The deletion_log lines catch the snapshot up with the hand
-- edit of 20261118033308 (already nullable, ON DELETE SET NULL there), so they change nothing.
ALTER TABLE "question_versions" ADD COLUMN "difficulty" text;--> statement-breakpoint
ALTER TABLE "question_versions" DISABLE TRIGGER "question_versions_no_update";--> statement-breakpoint
UPDATE "question_versions" AS v SET "difficulty" = q."difficulty" FROM "questions" AS q WHERE q."id" = v."question_id" AND q."owner_id" = v."owner_id";--> statement-breakpoint
ALTER TABLE "question_versions" ENABLE TRIGGER "question_versions_no_update";--> statement-breakpoint
ALTER TABLE "question_versions" ALTER COLUMN "difficulty" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "deletion_log" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "deletion_log" DROP CONSTRAINT "deletion_log_owner_id_profiles_id_fkey", ADD CONSTRAINT "deletion_log_owner_id_profiles_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_difficulty_check" CHECK ("difficulty" in ('mudah', 'sedang', 'sulit'));
