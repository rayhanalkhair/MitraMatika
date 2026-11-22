-- Hand-written. Runs before the baseline because its policies name the `authenticated` role
-- and call auth.uid(): both must exist when CREATE POLICY runs. The app owns them; nothing is
-- expected to be pre-created, so a stock Postgres works as is.

-- The role every teacher-scoped transaction switches to (runAsUser). Guarded: some hosts (for
-- example Neon with its Data API) already ship a role with this name. A pre-existing role is
-- adopted only if it cannot bypass RLS: a SUPERUSER or BYPASSRLS role would defeat every
-- policy, so the migration stops instead.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
  END IF;
  IF EXISTS (
    SELECT FROM pg_catalog.pg_roles
    WHERE rolname = 'authenticated' AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'role "authenticated" already exists with SUPERUSER or BYPASSRLS; it would bypass row level security. Remove those attributes (ALTER ROLE authenticated NOSUPERUSER NOBYPASSRLS) and run the migrations again.';
  END IF;
END
$$;--> statement-breakpoint

-- The migrating role is also the service connection, and runAsUser switches it to
-- `authenticated` with SET ROLE, which needs membership with the SET option. On PG16+ a role
-- created by a non-superuser CREATEROLE role (Neon's database owner) only gives its creator
-- ADMIN OPTION, and an adopted role gives nothing, so grant it explicitly. INHERIT FALSE keeps
-- the service connection from inheriting anything from `authenticated`. Before PG16 the
-- options do not exist and a plain grant is the membership SET ROLE needs.
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 160000 THEN
    EXECUTE 'GRANT authenticated TO CURRENT_USER WITH SET TRUE, INHERIT FALSE';
  ELSE
    EXECUTE 'GRANT authenticated TO CURRENT_USER';
  END IF;
END
$$;--> statement-breakpoint

CREATE SCHEMA IF NOT EXISTS auth;--> statement-breakpoint

-- The signed-in user's id, read from the transaction-local setting runAsUser writes with
-- set_config('request.jwt.claim.sub', ...). Null when it is unset or empty.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$ LANGUAGE sql STABLE;--> statement-breakpoint

GRANT USAGE ON SCHEMA auth TO authenticated;
