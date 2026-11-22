-- Hand-written: least-privilege grants, immutability, and the circular deferrable foreign
-- keys. Drizzle cannot express any of this. Start from nothing for `authenticated`, on the
-- existing tables and on every table created later, then grant back only what each table
-- needs. No role exists for signed-out requests: they never reach Postgres
-- as anything but the service connection.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;--> statement-breakpoint

-- Defence in depth: nothing reaches `authenticated` through PUBLIC either, on the existing
-- tables or on later ones, and `authenticated` keeps only USAGE on schema public (no CREATE),
-- which the explicit table grants below need to be reachable.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON SCHEMA public FROM authenticated;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO authenticated;--> statement-breakpoint

-- Curriculum is global and read-only for teachers (loaded through the service connection).
GRANT SELECT ON "curriculum_versions", "cp_elements", "topics", "learning_objectives" TO authenticated;--> statement-breakpoint

-- Identity: a teacher manages only their own profile row; deletion happens by cascade
-- from "user".
GRANT SELECT, INSERT, UPDATE ON "profiles" TO authenticated;--> statement-breakpoint

-- Teacher-initiated writes: creating a generation request, and approving or rejecting a
-- question (only the approval columns are updatable).
GRANT SELECT, INSERT ON "generation_requests" TO authenticated;--> statement-breakpoint
GRANT SELECT ON "questions" TO authenticated;--> statement-breakpoint
GRANT UPDATE ("status", "approved_version_id", "approved_at", "row_version", "updated_at", "approval_override", "banked_at") ON "questions" TO authenticated;--> statement-breakpoint

-- Everything else a teacher can see is written by the service connection (background jobs).
GRANT SELECT ON "generation_runs", "question_versions", "question_sources", "verification_runs", "jobs", "ai_calls", "job_runs" TO authenticated;--> statement-breakpoint

-- No grant to authenticated (and no RLS policy) on: "user", "session", "account",
-- "verification" (Better Auth, service connection only), audit_log, usage_events, app_errors.

-- question_versions is immutable: reject updates from every role, including the service
-- connection. Rows can still be deleted through the parent cascade (account deletion).
CREATE FUNCTION "question_versions_immutable"() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'question_versions rows are immutable' USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "question_versions_immutable"() FROM PUBLIC, authenticated;--> statement-breakpoint
CREATE TRIGGER "question_versions_no_update" BEFORE UPDATE ON "question_versions" FOR EACH ROW EXECUTE FUNCTION "question_versions_immutable"();--> statement-breakpoint

-- questions and question_versions reference each other; these composite foreign keys are
-- deferrable so a question and its first version can be inserted in either order inside one
-- transaction. With MATCH SIMPLE a null version id is not checked.
ALTER TABLE "questions" ADD CONSTRAINT "questions_current_version_fk" FOREIGN KEY ("current_version_id", "owner_id") REFERENCES "question_versions" ("id", "owner_id") DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_approved_version_fk" FOREIGN KEY ("approved_version_id", "owner_id") REFERENCES "question_versions" ("id", "owner_id") DEFERRABLE INITIALLY DEFERRED;
