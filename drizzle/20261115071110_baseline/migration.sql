CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL UNIQUE,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "verification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verification" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY,
	"display_name" text,
	"locale" text DEFAULT 'id-ID' NOT NULL,
	"timezone" text DEFAULT 'Asia/Jakarta' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cp_elements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"curriculum_version_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"outcome_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cp_elements_version_code_unique" UNIQUE("curriculum_version_id","code")
);
--> statement-breakpoint
ALTER TABLE "cp_elements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "curriculum_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"code" text NOT NULL UNIQUE,
	"title" text NOT NULL,
	"source_title" text NOT NULL,
	"source_url" text NOT NULL,
	"decree_ref" text,
	"published_on" date NOT NULL,
	"retrieved_on" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "curriculum_versions_status_check" CHECK ("status" in ('draft', 'active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "curriculum_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "learning_objectives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"topic_id" uuid NOT NULL,
	"code" text NOT NULL,
	"text" text NOT NULL,
	"source_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_objectives_topic_code_unique" UNIQUE("topic_id","code")
);
--> statement-breakpoint
ALTER TABLE "learning_objectives" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"curriculum_version_id" uuid NOT NULL,
	"cp_element_id" uuid NOT NULL,
	"grade" smallint NOT NULL,
	"stable_key" text NOT NULL,
	"title" text NOT NULL,
	"scope_notes" text NOT NULL,
	"source_ref" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topics_version_grade_key_unique" UNIQUE("curriculum_version_id","grade","stable_key"),
	CONSTRAINT "topics_grade_check" CHECK ("grade" in (7, 8, 9))
);
--> statement-breakpoint
ALTER TABLE "topics" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ai_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" uuid NOT NULL,
	"job_id" uuid,
	"task" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cached_tokens" integer,
	"latency_ms" integer,
	"outcome" text NOT NULL,
	"error_code" text,
	"failure_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_calls_outcome_check" CHECK ("outcome" in ('ok', 'error'))
);
--> statement-breakpoint
ALTER TABLE "ai_calls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app_errors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" uuid,
	"correlation_id" uuid,
	"source" text NOT NULL,
	"code" text,
	"message" text NOT NULL,
	"context" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_errors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" uuid NOT NULL,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"job_id" uuid NOT NULL,
	"owner_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text NOT NULL,
	"error_code" text,
	"duration_ms" integer,
	CONSTRAINT "job_runs_outcome_check" CHECK ("outcome" in ('running', 'succeeded', 'failed', 'deferred'))
);
--> statement-breakpoint
ALTER TABLE "job_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"lock_token" uuid,
	"progress" jsonb,
	"error" jsonb,
	"correlation_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "jobs_status_check" CHECK ("status" in ('queued', 'running', 'succeeded', 'failed', 'deferred', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" uuid NOT NULL,
	"event" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"duration_ms" integer,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "generation_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" uuid NOT NULL,
	"mode" text DEFAULT 'topic' NOT NULL,
	"input_kind" text DEFAULT 'form' NOT NULL,
	"chat_text" text,
	"params" jsonb DEFAULT '{}' NOT NULL,
	"source_selection" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_requests_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "generation_requests_mode_check" CHECK ("mode" in ('topic', 'material')),
	CONSTRAINT "generation_requests_input_kind_check" CHECK ("input_kind" in ('form', 'chat')),
	CONSTRAINT "generation_requests_status_check" CHECK ("status" in ('queued', 'running', 'succeeded', 'partial', 'failed', 'deferred', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "generation_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "generation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"task" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"curriculum_version_id" uuid,
	"input_tokens" integer,
	"output_tokens" integer,
	"cached_tokens" integer,
	"latency_ms" integer,
	"outcome" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_runs_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "generation_runs_outcome_check" CHECK ("outcome" in ('ok', 'error'))
);
--> statement-breakpoint
ALTER TABLE "generation_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "question_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" uuid NOT NULL,
	"question_version_id" uuid NOT NULL,
	"kind" text DEFAULT 'curriculum' NOT NULL,
	"topic_id" uuid,
	"anchor_label" text,
	"excerpt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_sources_kind_check" CHECK ("kind" in ('curriculum'))
);
--> statement-breakpoint
ALTER TABLE "question_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "question_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"author" text NOT NULL,
	"change_kind" text NOT NULL,
	"stem_md" text NOT NULL,
	"options" jsonb NOT NULL,
	"answer" jsonb NOT NULL,
	"explanation_md" text NOT NULL,
	"steps" jsonb NOT NULL,
	"answer_rules" jsonb,
	"verification_claims" jsonb NOT NULL,
	"verification_status" text NOT NULL,
	"teacher_override" jsonb,
	"generation_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_versions_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "question_versions_question_version_unique" UNIQUE("question_id","version_no"),
	CONSTRAINT "question_versions_author_check" CHECK ("author" in ('ai', 'teacher')),
	CONSTRAINT "question_versions_change_kind_check" CHECK ("change_kind" in ('generated', 'edited', 'regenerated', 'restored')),
	CONSTRAINT "question_versions_verification_status_check" CHECK ("verification_status" in ('terverifikasi', 'dicek_silang_ai', 'belum_dapat_diverifikasi', 'ketidaksesuaian'))
);
--> statement-breakpoint
ALTER TABLE "question_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"origin" text DEFAULT 'generated' NOT NULL,
	"grade" smallint NOT NULL,
	"type" text DEFAULT 'multiple_choice' NOT NULL,
	"difficulty" text NOT NULL,
	"cognitive_level" text,
	"topic_id" uuid NOT NULL,
	"learning_objective_id" uuid,
	"current_version_id" uuid,
	"approved_version_id" uuid,
	"generation_request_id" uuid,
	"approved_at" timestamp with time zone,
	"approval_override" jsonb,
	"banked_at" timestamp with time zone,
	"row_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "questions_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "questions_status_check" CHECK ("status" in ('draft', 'approved', 'archived')),
	CONSTRAINT "questions_origin_check" CHECK ("origin" in ('generated', 'manual', 'imported')),
	CONSTRAINT "questions_grade_check" CHECK ("grade" in (7, 8, 9)),
	CONSTRAINT "questions_type_check" CHECK ("type" in ('multiple_choice')),
	CONSTRAINT "questions_difficulty_check" CHECK ("difficulty" in ('mudah', 'sedang', 'sulit'))
);
--> statement-breakpoint
ALTER TABLE "questions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "verification_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" uuid NOT NULL,
	"question_version_id" uuid NOT NULL,
	"verifier_version" text NOT NULL,
	"status" text NOT NULL,
	"checks" jsonb DEFAULT '[]' NOT NULL,
	"cross_check" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_runs_status_check" CHECK ("status" in ('terverifikasi', 'dicek_silang_ai', 'belum_dapat_diverifikasi', 'ketidaksesuaian'))
);
--> statement-breakpoint
ALTER TABLE "verification_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");--> statement-breakpoint
CREATE INDEX "ai_calls_created_at_idx" ON "ai_calls" ("created_at");--> statement-breakpoint
CREATE INDEX "job_runs_job_id_idx" ON "job_runs" ("job_id");--> statement-breakpoint
CREATE INDEX "jobs_status_run_after_idx" ON "jobs" ("status","run_after");--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_id_user_id_fkey" FOREIGN KEY ("id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "cp_elements" ADD CONSTRAINT "cp_elements_curriculum_version_id_curriculum_versions_id_fkey" FOREIGN KEY ("curriculum_version_id") REFERENCES "curriculum_versions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "learning_objectives" ADD CONSTRAINT "learning_objectives_topic_id_topics_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_curriculum_version_id_curriculum_versions_id_fkey" FOREIGN KEY ("curriculum_version_id") REFERENCES "curriculum_versions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_cp_element_id_cp_elements_id_fkey" FOREIGN KEY ("cp_element_id") REFERENCES "cp_elements"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_owner_id_profiles_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_job_owner_fk" FOREIGN KEY ("job_id","owner_id") REFERENCES "jobs"("id","owner_id");--> statement-breakpoint
ALTER TABLE "app_errors" ADD CONSTRAINT "app_errors_owner_id_profiles_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_owner_id_profiles_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_job_id_jobs_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_owner_id_profiles_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_owner_id_profiles_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "generation_requests" ADD CONSTRAINT "generation_requests_owner_id_profiles_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "generation_requests" ADD CONSTRAINT "generation_requests_job_owner_fk" FOREIGN KEY ("job_id","owner_id") REFERENCES "jobs"("id","owner_id");--> statement-breakpoint
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_owner_id_profiles_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_65ZrcGIXkM2a_fkey" FOREIGN KEY ("curriculum_version_id") REFERENCES "curriculum_versions"("id");--> statement-breakpoint
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_request_owner_fk" FOREIGN KEY ("request_id","owner_id") REFERENCES "generation_requests"("id","owner_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_sources" ADD CONSTRAINT "question_sources_owner_id_profiles_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_sources" ADD CONSTRAINT "question_sources_topic_id_topics_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id");--> statement-breakpoint
ALTER TABLE "question_sources" ADD CONSTRAINT "question_sources_version_owner_fk" FOREIGN KEY ("question_version_id","owner_id") REFERENCES "question_versions"("id","owner_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_owner_id_profiles_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_question_owner_fk" FOREIGN KEY ("question_id","owner_id") REFERENCES "questions"("id","owner_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_run_owner_fk" FOREIGN KEY ("generation_run_id","owner_id") REFERENCES "generation_runs"("id","owner_id");--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_owner_id_profiles_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_topic_id_topics_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id");--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_learning_objective_id_learning_objectives_id_fkey" FOREIGN KEY ("learning_objective_id") REFERENCES "learning_objectives"("id");--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_generation_request_owner_fk" FOREIGN KEY ("generation_request_id","owner_id") REFERENCES "generation_requests"("id","owner_id");--> statement-breakpoint
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_owner_id_profiles_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_version_owner_fk" FOREIGN KEY ("question_version_id","owner_id") REFERENCES "question_versions"("id","owner_id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "profiles_self_access" ON "profiles" AS PERMISSIVE FOR ALL TO "authenticated" USING ("profiles"."id" = auth.uid()) WITH CHECK ("profiles"."id" = auth.uid());--> statement-breakpoint
CREATE POLICY "cp_elements_read" ON "cp_elements" AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "curriculum_versions_read" ON "curriculum_versions" AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "learning_objectives_read" ON "learning_objectives" AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "topics_read" ON "topics" AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "ai_calls_owner_select" ON "ai_calls" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("ai_calls"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "job_runs_owner_select" ON "job_runs" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("job_runs"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "jobs_owner_select" ON "jobs" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("jobs"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "generation_requests_owner_select" ON "generation_requests" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("generation_requests"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "generation_requests_owner_insert" ON "generation_requests" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("generation_requests"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "generation_runs_owner_select" ON "generation_runs" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("generation_runs"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "question_sources_owner_select" ON "question_sources" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("question_sources"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "question_versions_owner_select" ON "question_versions" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("question_versions"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "questions_owner_select" ON "questions" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("questions"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "questions_owner_update" ON "questions" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("questions"."owner_id" = auth.uid()) WITH CHECK ("questions"."owner_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "verification_runs_owner_select" ON "verification_runs" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("verification_runs"."owner_id" = auth.uid());