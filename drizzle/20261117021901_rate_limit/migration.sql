CREATE TABLE "rate_limit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"key" text NOT NULL UNIQUE,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rate_limit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Hand-added: Better Auth's rate-limit counters are for the service connection only, like
-- "user", "session", "account" and "verification": no grant and no policy. The default
-- privileges already keep new tables closed; this states it for this table explicitly.
REVOKE ALL ON "rate_limit" FROM PUBLIC, authenticated;
