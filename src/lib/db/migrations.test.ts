import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAsUser } from "./client";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  MIGRATIONS_FOLDER,
  type TestDatabase,
} from "./test-harness";

const APP_TABLES = [
  "account",
  "ai_calls",
  "app_errors",
  "assessment_items",
  "assessment_sections",
  "assessments",
  "audit_log",
  "cp_elements",
  "curriculum_versions",
  "deletion_log",
  "exports",
  "folders",
  "generation_requests",
  "generation_runs",
  "job_runs",
  "jobs",
  "learning_objectives",
  "material_pages",
  "material_sections",
  "material_uploads",
  "materials",
  "ocr_usage",
  "profiles",
  "question_sources",
  "question_usages",
  "question_versions",
  "questions",
  "rate_limit",
  "school_templates",
  "session",
  "solver_sessions",
  "solver_solutions",
  "topics",
  "usage_events",
  "user",
  "verification",
  "verification_runs",
];

// Every table-level privilege the authenticated role holds after the migrations. Column-level
// UPDATE on questions is asserted in rls.test.ts.
const EXPECTED_TABLE_GRANTS = {
  ai_calls: "SELECT",
  // UPDATE on the four assessment tables is column-level (rls.test.ts).
  assessment_items: "DELETE,INSERT,SELECT",
  assessment_sections: "DELETE,INSERT,SELECT",
  // No DELETE: only the trash deletes them, on the service connection (Task 10 review).
  assessments: "INSERT,SELECT",
  cp_elements: "SELECT",
  curriculum_versions: "SELECT",
  deletion_log: "SELECT",
  exports: "SELECT",
  // UPDATE on folders, materials and material_sections is column-level (materials.test.ts). No
  // DELETE on folders or materials: only the trash deletes them, on the service connection.
  folders: "INSERT,SELECT",
  generation_requests: "INSERT,SELECT",
  generation_runs: "SELECT",
  job_runs: "SELECT",
  jobs: "SELECT",
  learning_objectives: "SELECT",
  material_pages: "SELECT",
  material_sections: "DELETE,INSERT,SELECT",
  material_uploads: "SELECT",
  materials: "SELECT",
  ocr_usage: "SELECT",
  profiles: "INSERT,SELECT,UPDATE",
  question_sources: "SELECT",
  question_usages: "SELECT",
  question_versions: "SELECT",
  questions: "SELECT",
  school_templates: "INSERT,SELECT",
  solver_sessions: "SELECT",
  solver_solutions: "SELECT",
  topics: "SELECT",
  verification_runs: "SELECT",
};

let database: TestDatabase;
const rows = async (query: string) => (await database.db.execute(sql.raw(query))).rows;

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await database.client.close();
});

describe("migrations", () => {
  it("apply cleanly from an empty database and create exactly the app tables", async () => {
    const result = await rows(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`,
    );
    expect(result.map((r) => r.tablename)).toEqual(APP_TABLES);
  });

  it("enable row level security on every table", async () => {
    const result = await rows(
      `select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(result).toEqual([]);
  });

  it("create pg_trgm, the trash and search columns and their indexes", async () => {
    const extension = await rows(
      `select extname from pg_extension where extname = 'pg_trgm'`,
    );
    expect(extension).toEqual([{ extname: "pg_trgm" }]);

    const columns = await rows(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'questions'
         and column_name in ('deleted_at', 'purge_after', 'search_text') order by column_name`,
    );
    expect(columns).toEqual([
      {
        column_name: "deleted_at",
        data_type: "timestamp with time zone",
        is_nullable: "YES",
        column_default: null,
      },
      {
        column_name: "purge_after",
        data_type: "timestamp with time zone",
        is_nullable: "YES",
        column_default: null,
      },
      {
        column_name: "search_text",
        data_type: "text",
        is_nullable: "NO",
        column_default: "''::text",
      },
    ]);

    const indexes = await rows(
      `select indexname, indexdef from pg_indexes
       where tablename = 'questions' and indexname in ('questions_search_trgm', 'questions_owner_deleted_banked_idx')
       order by indexname`,
    );
    expect(indexes).toHaveLength(2);
    const def = (name: string) =>
      String(indexes.find((i) => i.indexname === name)?.indexdef);
    expect(def("questions_search_trgm")).toMatch(
      /USING gin \(search_text gin_trgm_ops\)/,
    );
    expect(def("questions_owner_deleted_banked_idx")).toMatch(
      /\(owner_id, deleted_at, banked_at\)/,
    );
  });

  it("keeps deletion_log rows with a null owner when the account is deleted", async () => {
    const col = await rows(
      `select is_nullable from information_schema.columns
       where table_name = 'deletion_log' and column_name = 'owner_id'`,
    );
    expect(col).toEqual([{ is_nullable: "YES" }]);
    const fk = await rows(
      `select confdeltype from pg_constraint where conname = 'deletion_log_owner_id_profiles_id_fkey'`,
    );
    expect(fk).toEqual([{ confdeltype: "n" }]);
  });

  it("create the assessment indexes: one default template, owner trash, expiry and foreign keys", async () => {
    const result = await rows(
      `select indexname, indexdef from pg_indexes
       where tablename in ('school_templates', 'assessments', 'assessment_sections', 'assessment_items', 'exports', 'question_usages')
       order by indexname`,
    );
    const def = (name: string) =>
      result.find((i) => i.indexname === name)?.indexdef?.toString() ?? "missing";
    expect(def("school_templates_one_default_per_owner")).toMatch(
      /UNIQUE INDEX .* \(owner_id\) WHERE \(is_default AND \(deleted_at IS NULL\)\)/,
    );
    expect(def("school_templates_owner_deleted_idx")).toMatch(/\(owner_id, deleted_at\)/);
    expect(def("assessments_owner_deleted_idx")).toMatch(/\(owner_id, deleted_at\)/);
    expect(def("exports_expires_at_idx")).toMatch(/\(expires_at\)/);
    for (const name of [
      "assessments_template_idx",
      "assessment_sections_assessment_idx",
      "assessment_items_section_idx",
      "assessment_items_question_idx",
      "assessment_items_version_idx",
      "exports_assessment_idx",
      "exports_job_idx",
      "question_usages_question_idx",
      "question_usages_version_idx",
      "question_usages_export_idx",
    ]) {
      expect(def(name), name).not.toBe("missing");
    }
  });

  it("set only export_id to null when an export row goes (the usage keeps its owner)", async () => {
    const result = await rows(
      `select confdeltype, pg_get_constraintdef(oid) as def from pg_constraint
       where conname = 'question_usages_export_owner_fk'`,
    );
    expect(result.map((r) => r.confdeltype)).toEqual(["n"]);
    expect(String(result[0]?.def)).toMatch(
      /FOREIGN KEY \(export_id, owner_id\) REFERENCES exports\(id, owner_id\) ON DELETE SET NULL \(export_id\)/,
    );
  });

  it("link profiles to user with on delete cascade", async () => {
    const result = await rows(
      `select confdeltype from pg_constraint
       where contype = 'f' and conrelid = 'public.profiles'::regclass
         and confrelid = 'public."user"'::regclass`,
    );
    expect(result).toEqual([{ confdeltype: "c" }]);
  });

  it("declare the two circular question/version foreign keys as deferrable and composite", async () => {
    const result = await rows(
      `select conname, condeferrable, condeferred, array_length(conkey, 1) as columns
       from pg_constraint
       where conname in ('questions_current_version_fk', 'questions_approved_version_fk')
       order by conname`,
    );
    expect(result).toEqual([
      {
        conname: "questions_approved_version_fk",
        condeferrable: true,
        condeferred: true,
        columns: 2,
      },
      {
        conname: "questions_current_version_fk",
        condeferrable: true,
        condeferred: true,
        columns: 2,
      },
    ]);
  });

  it("install the question_versions immutability trigger", async () => {
    const result = await rows(
      `select tgname from pg_trigger
       where tgrelid = 'public.question_versions'::regclass and not tgisinternal`,
    );
    expect(result.map((r) => r.tgname)).toEqual(["question_versions_no_update"]);
  });

  it("keep the immutability function out of reach of PUBLIC and authenticated", async () => {
    const result = await rows(
      `select has_function_privilege('authenticated', 'public.question_versions_immutable()', 'execute') as can,
              (select prosecdef from pg_proc where proname = 'question_versions_immutable') as definer,
              (select proconfig::text from pg_proc where proname = 'question_versions_immutable') as config`,
    );
    expect(result).toEqual([
      { can: false, definer: false, config: '{"search_path=\\"\\""}' },
    ]);
  });

  it("leave no default table privilege for authenticated, so new tables are deny-by-default", async () => {
    const result = await rows(
      `select defaclacl::text as acl
       from pg_default_acl where defaclnamespace = 'public'::regnamespace`,
    );
    for (const row of result) {
      expect(String(row.acl)).not.toMatch(/authenticated=/);
    }
  });

  it("grant authenticated exactly the expected table privileges", async () => {
    const result = await rows(
      `select table_name, string_agg(privilege_type, ',' order by privilege_type) as privileges
       from information_schema.role_table_grants
       where grantee = 'authenticated' and table_schema = 'public'
       group by table_name order by table_name`,
    );
    expect(Object.fromEntries(result.map((r) => [r.table_name, r.privileges]))).toEqual(
      EXPECTED_TABLE_GRANTS,
    );
  });

  it("create the authenticated role and auth.uid() themselves, with no anon role", async () => {
    const result = await rows(
      `select (select count(*)::int from pg_roles where rolname = 'authenticated') as authenticated,
              (select count(*)::int from pg_roles where rolname = 'anon') as anon,
              to_regprocedure('auth.uid()') is not null as uid,
              has_schema_privilege('authenticated', 'auth', 'usage') as usage`,
    );
    expect(result).toEqual([{ authenticated: 1, anon: 0, uid: true, usage: true }]);
  });

  it("make auth.uid() read the request.jwt.claim.sub setting", async () => {
    const uid = "33333333-3333-4333-8333-333333333333";
    const result = await database.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('request.jwt.claim.sub', ${uid}, true)`);
      return (await tx.execute(sql`select auth.uid()::text as uid`)).rows;
    });
    expect(result).toEqual([{ uid }]);
    const empty = await rows(`select auth.uid() as uid`);
    expect(empty).toEqual([{ uid: null }]);
  });
});

describe("migrations on a bare database", () => {
  it(
    "run with nothing pre-created, and again when the authenticated role already exists",
    async () => {
      const bare = new PGlite({ extensions: { pg_trgm } });
      try {
        await migrate(drizzle({ client: bare }), { migrationsFolder: MIGRATIONS_FOLDER });
        const tables = await bare.query<{ n: number }>(
          `select count(*)::int as n from pg_tables where schemaname = 'public'`,
        );
        expect(tables.rows[0]?.n).toBe(APP_TABLES.length);
        const role = await bare.query(
          `select rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb
           from pg_roles where rolname = 'authenticated'`,
        );
        expect(role.rows).toEqual([
          {
            rolsuper: false,
            rolbypassrls: false,
            rolcanlogin: false,
            rolcreaterole: false,
            rolcreatedb: false,
          },
        ]);
      } finally {
        await bare.close();
      }

      // A host may already ship a plain `authenticated` role, possibly with default
      // privileges on new tables for it or for PUBLIC, and CREATE on schema public: the guarded
      // create must accept it, and the revokes must still leave only the explicit grants.
      const preexisting = new PGlite({ extensions: { pg_trgm } });
      try {
        await preexisting.exec(`create role authenticated nologin`);
        await preexisting.exec(
          `alter default privileges in schema public grant all on tables to authenticated`,
        );
        await preexisting.exec(
          `alter default privileges in schema public grant select on tables to public`,
        );
        await preexisting.exec(`grant create on schema public to authenticated`);
        await migrate(drizzle({ client: preexisting }), {
          migrationsFolder: MIGRATIONS_FOLDER,
        });
        await preexisting.exec(`create table zz_future (id int)`);
        const result = await preexisting.query(
          `select (select count(*)::int from pg_roles where rolname = 'authenticated') as roles,
                  has_table_privilege('authenticated', 'public.audit_log', 'select') as audit_log,
                  has_table_privilege('authenticated', 'public."user"', 'select') as auth_user,
                  has_table_privilege('authenticated', 'public.zz_future', 'select') as future,
                  has_table_privilege('authenticated', 'public.jobs', 'select') as jobs,
                  has_table_privilege('authenticated', 'public.jobs', 'insert') as jobs_insert,
                  has_table_privilege('public.zz_future', 'select') as owner_future,
                  has_schema_privilege('authenticated', 'public', 'create') as schema_create,
                  has_schema_privilege('authenticated', 'public', 'usage') as schema_usage`,
        );
        expect(result.rows).toEqual([
          {
            roles: 1,
            audit_log: false,
            auth_user: false,
            future: false,
            jobs: true,
            jobs_insert: false,
            owner_future: true,
            schema_create: false,
            schema_usage: true,
          },
        ]);
      } finally {
        await preexisting.close();
      }
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "let a non-superuser CREATEROLE role migrate and then switch to authenticated in runAsUser",
    async () => {
      // Like Neon's database owner: CREATEROLE but not superuser. On PG16+ creating a role
      // gives its creator only ADMIN OPTION, so the migration must grant itself SET.
      const client = new PGlite({ extensions: { pg_trgm } });
      try {
        await client.exec(`create role migrator createrole login`);
        await client.exec(`grant create on database postgres to migrator`);
        await client.exec(`grant create on schema public to migrator`);
        await client.exec(`set session authorization migrator`);
        const db = drizzle({ client });
        await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

        const uid = "44444444-4444-4444-8444-444444444444";
        await client.query(
          `insert into "user" (id, name, email) values ($1, 'M', 'm@example.test')`,
          [uid],
        );
        await client.query(`insert into profiles (id) values ($1)`, [uid]);
        const seen = await runAsUser(
          db,
          uid,
          async (tx) =>
            (
              await tx.execute(
                sql`select current_user as role, (select count(*)::int from profiles) as n`,
              )
            ).rows,
        );
        expect(seen).toEqual([{ role: "authenticated", n: 1 }]);

        // The migrating role must not inherit authenticated's privileges, and a table it
        // creates later is still closed to authenticated.
        await client.exec(`create table zz_later (id int)`);
        const checks = await client.query(
          `select has_table_privilege('authenticated', 'public.zz_later', 'select') as later,
                  pg_has_role('authenticated', 'SET') as can_set,
                  pg_has_role('authenticated', 'USAGE') as inherits`,
        );
        expect(checks.rows).toEqual([{ later: false, can_set: true, inherits: false }]);
      } finally {
        await client.close();
      }
    },
    DB_TEST_TIMEOUT,
  );

  it.each([
    ["bypassrls", "create role authenticated nologin bypassrls"],
    ["superuser", "create role authenticated nologin superuser"],
  ])(
    "refuse to adopt a pre-existing authenticated role with %s",
    async (_label, createRole) => {
      const client = new PGlite({ extensions: { pg_trgm } });
      try {
        await client.exec(createRole);
        let message = "";
        try {
          await migrate(drizzle({ client }), { migrationsFolder: MIGRATIONS_FOLDER });
        } catch (error) {
          let current: unknown = error;
          while (current instanceof Error) {
            message += `${current.message} | `;
            current = current.cause;
          }
        }
        expect(message).toMatch(/authenticated.*(SUPERUSER|BYPASSRLS)/);
      } finally {
        await client.close();
      }
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "backfill each existing version's difficulty from its question before it becomes NOT NULL",
    async () => {
      // Every migration before the one that adds question_versions.difficulty.
      const before = mkdtempSync(join(tmpdir(), "migrations-"));
      for (const entry of readdirSync(MIGRATIONS_FOLDER)) {
        if (entry < "20261118152932") {
          cpSync(join(MIGRATIONS_FOLDER, entry), join(before, entry), {
            recursive: true,
          });
        }
      }
      const client = new PGlite({ extensions: { pg_trgm } });
      try {
        await migrate(drizzle({ client }), { migrationsFolder: before });
        const user = "55555555-5555-4555-8555-555555555555";
        await client.exec(`
          insert into "user" (id, name, email) values ('${user}', 'T', 't@example.test');
          insert into profiles (id) values ('${user}');
          insert into curriculum_versions (id, code, title, source_title, source_url, published_on, retrieved_on, status)
            values ('00000000-0000-4000-8000-000000000001', 'v1', 'CP', 'S', 'https://example.test', '2025-01-01', '2026-09-01', 'active');
          insert into cp_elements (id, curriculum_version_id, code, name, outcome_text)
            values ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'a', 'A', 'C');
          insert into topics (id, curriculum_version_id, cp_element_id, grade, stable_key, title, scope_notes, source_ref, sort_order)
            values ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 8, 'p', 'P', 'C', 'r', 1);
          insert into questions (id, owner_id, grade, difficulty, topic_id)
            values ('10000000-0000-4000-8000-000000000013', '${user}', 8, 'sulit', '00000000-0000-4000-8000-000000000003');
          insert into question_versions (id, owner_id, question_id, version_no, author, change_kind, stem_md, options, answer, explanation_md, steps, verification_claims, verification_status)
            values ('10000000-0000-4000-8000-000000000014', '${user}', '10000000-0000-4000-8000-000000000013', 1, 'ai', 'generated', 'S', '[]', '{}', 'E', '[]', '[]', 'belum_dapat_diverifikasi');
        `);

        await migrate(drizzle({ client }), { migrationsFolder: MIGRATIONS_FOLDER });

        const rows = await client.query<{ difficulty: string; nullable: string }>(
          `select v.difficulty,
                  (select is_nullable from information_schema.columns
                    where table_name = 'question_versions' and column_name = 'difficulty') as nullable
             from question_versions v`,
        );
        expect(rows.rows).toEqual([{ difficulty: "sulit", nullable: "NO" }]);
        // The immutability trigger is back on after the backfill.
        await expect(
          client.exec(`update question_versions set stem_md = 'x'`),
        ).rejects.toThrow();
      } finally {
        await client.close();
        rmSync(before, { recursive: true, force: true });
      }
    },
    DB_TEST_TIMEOUT,
  );
});
