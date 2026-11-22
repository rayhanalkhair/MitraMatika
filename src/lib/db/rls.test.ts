import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAsUser } from "./client";
import { FIXTURE, fid, seedFixtures } from "./test-fixtures";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "./test-harness";

// Every table in the public schema must be listed in exactly one of these groups; the
// completeness guard at the bottom fails if a table is missing, so a future table cannot
// ship without an RLS test.
const CURRICULUM = [
  "curriculum_versions",
  "cp_elements",
  "topics",
  "learning_objectives",
];
const WRITABLE = ["profiles", "generation_requests", "questions"];
// Written by the teacher through runAsUser (Ruling R1): every verb, owner rows only.
const ASSESSMENT_TABLES = [
  "school_templates",
  "assessments",
  "assessment_sections",
  "assessment_items",
];
// Partly teacher-written (Task 2 of the materials plan): folders (insert, rename, move), material
// metadata (title, folder, grade, year) and sections; materials.test.ts covers the column rules.
const MATERIAL_TABLES = ["folders", "materials", "material_sections"];
const READ_ONLY = [
  "generation_runs",
  "question_versions",
  "question_sources",
  "verification_runs",
  "jobs",
  "ai_calls",
  "job_runs",
  "deletion_log",
  "exports",
  "question_usages",
  "material_pages",
  "ocr_usage",
  "material_uploads",
  "solver_sessions",
  "solver_solutions",
];
// Better Auth's tables and the system tables: no grant and no policy for teachers.
const AUTH_TABLES = ["user", "session", "account", "verification", "rate_limit"];
const NO_ACCESS = ["audit_log", "usage_events", "app_errors", ...AUTH_TABLES];

// The fixture id of each owner-readable table's row for user 1 (A) / 2 (B).
const ROW_ID: Record<string, (o: 1 | 2) => string> = {
  profiles: (o) => (o === 1 ? USER_A : USER_B),
  generation_requests: FIXTURE.request,
  questions: FIXTURE.question,
  generation_runs: FIXTURE.run,
  question_versions: FIXTURE.version,
  question_sources: FIXTURE.source,
  verification_runs: FIXTURE.verification,
  jobs: FIXTURE.job,
  ai_calls: FIXTURE.aiCall,
  job_runs: FIXTURE.jobRun,
  deletion_log: FIXTURE.deletion,
  school_templates: FIXTURE.template,
  assessments: FIXTURE.assessment,
  assessment_sections: FIXTURE.section,
  assessment_items: FIXTURE.item,
  exports: FIXTURE.export,
  question_usages: FIXTURE.questionUsage,
  folders: FIXTURE.folder,
  materials: FIXTURE.material,
  material_sections: FIXTURE.materialSection,
  material_pages: FIXTURE.materialPage,
  ocr_usage: FIXTURE.ocrUsage,
  material_uploads: FIXTURE.materialUpload,
  solver_sessions: FIXTURE.solverSession,
  solver_solutions: FIXTURE.solverSolution,
};

function errorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(" | ");
}

// Drizzle wraps the real Postgres error, so match against the whole cause chain.
// Hard deletes and the trash columns of these two belong to the service connection (Task 10).
const HARD_DELETE_REVOKED: string[] = ["assessments", "school_templates"];

async function failureOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return errorChain(error);
  }
  throw new Error("expected the statement to fail, but it succeeded");
}

// The SQLSTATE of the first error in the cause chain that carries one.
async function sqlstateOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    let current: unknown = error;
    while (current instanceof Error) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") return code;
      current = current.cause;
    }
    return undefined;
  }
  throw new Error("expected the statement to fail, but it succeeded");
}

// Table names are quoted everywhere: "user" is a reserved word.
const q = (table: string) => `"${table}"`;

let database: TestDatabase;
// The transaction handle the PGlite-backed test database hands to runAsUser callbacks.
type Tx = Parameters<Parameters<TestDatabase["db"]["transaction"]>[0]>[0];
const asA = <T>(fn: (tx: Tx) => Promise<T>) => runAsUser(database.db, USER_A, fn);
const asB = <T>(fn: (tx: Tx) => Promise<T>) => runAsUser(database.db, USER_B, fn);

const count = async (tx: Tx, query: string) =>
  Number(((await tx.execute(sql.raw(query))).rows[0] as { n: unknown }).n);
const rows = async (tx: Tx, query: string) => (await tx.execute(sql.raw(query))).rows;

// Queries on the owner connection (no role switch), for catalog lookups.
const ownerRows = async (query: string) =>
  (await database.db.execute(sql.raw(query))).rows;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedFixtures(database.db);
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await database.client.close();
});

describe("tenant isolation (owner-readable tables)", () => {
  it.each([...WRITABLE, ...ASSESSMENT_TABLES, ...MATERIAL_TABLES, ...READ_ONLY])(
    "%s: each user sees only their own row",
    async (table) => {
      const own = (o: 1 | 2) => ROW_ID[table](o);
      const bothIds = `'${own(1)}', '${own(2)}'`;
      const query = `select count(*)::int as n from ${q(table)} where id in (${bothIds})`;

      expect(await asA((tx) => count(tx, query))).toBe(1);
      expect(await asB((tx) => count(tx, query))).toBe(1);
      expect(
        await asA((tx) =>
          count(tx, `select count(*)::int as n from ${q(table)} where id = '${own(2)}'`),
        ),
      ).toBe(0);
      expect(
        await asB((tx) =>
          count(tx, `select count(*)::int as n from ${q(table)} where id = '${own(1)}'`),
        ),
      ).toBe(0);
    },
  );
});

describe("deletion_log", () => {
  it("has RLS enabled with exactly one owner select policy", async () => {
    const result = await ownerRows(
      `select (select relrowsecurity from pg_class where oid = 'deletion_log'::regclass) as rls,
              (select string_agg(policyname || ':' || cmd, ',') from pg_policies where tablename = 'deletion_log') as policies`,
    );
    expect(result[0]).toEqual({
      rls: true,
      policies: "deletion_log_owner_select:SELECT",
    });
  });

  it("does not let another user select the rows of the owner", async () => {
    const query = `select id from deletion_log where owner_id = '${USER_A}'`;
    expect(await asA((tx) => rows(tx, query))).toEqual([{ id: FIXTURE.deletion(1) }]);
    expect(await asB((tx) => rows(tx, query))).toEqual([]);
  });
});

describe("curriculum tables", () => {
  it.each(CURRICULUM)("%s: readable by a teacher", async (table) => {
    expect(
      await asA((tx) => count(tx, `select count(*)::int as n from ${q(table)}`)),
    ).toBe(1);
  });

  it.each(CURRICULUM)("%s: not writable by a teacher", async (table) => {
    for (const statement of [
      `insert into ${q(table)} default values`,
      `update ${q(table)} set id = id`,
      `delete from ${q(table)}`,
    ]) {
      expect(await failureOf(() => asA((tx) => tx.execute(sql.raw(statement))))).toMatch(
        /permission denied/i,
      );
    }
  });
});

describe("read-only owner tables", () => {
  it.each(READ_ONLY)("%s: a teacher cannot insert, update or delete", async (table) => {
    for (const statement of [
      `insert into ${q(table)} default values`,
      `update ${q(table)} set id = id`,
      `delete from ${q(table)}`,
    ]) {
      expect(await failureOf(() => asA((tx) => tx.execute(sql.raw(statement))))).toMatch(
        /permission denied/i,
      );
    }
  });
});

describe("system tables with no grant and no policy", () => {
  it.each(NO_ACCESS)("%s: every verb is denied to a teacher", async (table) => {
    for (const statement of [
      `select 1 from ${q(table)} limit 1`,
      `insert into ${q(table)} default values`,
      `update ${q(table)} set id = id`,
      `delete from ${q(table)}`,
    ]) {
      expect(await failureOf(() => asA((tx) => tx.execute(sql.raw(statement))))).toMatch(
        /permission denied/i,
      );
    }
  });

  it.each(NO_ACCESS)("%s: RLS is enabled with no policy at all", async (table) => {
    const result = await database.db.execute(
      sql.raw(
        `select (select relrowsecurity from pg_class where oid = '${q(table)}'::regclass) as rls,
                (select count(*)::int from pg_policies where tablename = '${table}') as policies`,
      ),
    );
    expect(result.rows[0]).toEqual({ rls: true, policies: 0 });
  });
});

describe("roles", () => {
  it("has no anon role: only the app-owned authenticated role exists", async () => {
    const result = await ownerRows(
      `select rolname from pg_roles where rolname in ('anon', 'authenticated') order by rolname`,
    );
    expect(result.map((r) => r.rolname)).toEqual(["authenticated"]);
  });

  it("the authenticated role is really in effect inside runAsUser (positive control)", async () => {
    const [row] = await asA((tx) =>
      rows(tx, "select current_user as u, auth.uid()::text as uid"),
    );
    expect(row).toEqual({ u: "authenticated", uid: USER_A });
  });
});

describe("Better Auth tables", () => {
  it.each(AUTH_TABLES)("%s: has no privilege at all for authenticated", async (table) => {
    const granted = await ownerRows(
      `select privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and table_name = '${table}' and grantee = 'authenticated'`,
    );
    expect(granted).toEqual([]);
  });

  it("authenticated cannot read user, session, account, verification, rate_limit or audit_log", async () => {
    for (const table of [...AUTH_TABLES, "audit_log"]) {
      expect(
        await failureOf(() =>
          asA((tx) => tx.execute(sql.raw(`select * from ${q(table)}`))),
        ),
        table,
      ).toMatch(/permission denied/i);
    }
  });
});

describe("generation_requests", () => {
  it("lets a teacher create a request for themselves", async () => {
    const id = fid(1, 900);
    await asA((tx) =>
      tx.execute(
        sql.raw(
          `insert into generation_requests (id, owner_id) values ('${id}', '${USER_A}')`,
        ),
      ),
    );
    expect(
      await asA((tx) =>
        count(
          tx,
          `select count(*)::int as n from generation_requests where id = '${id}'`,
        ),
      ),
    ).toBe(1);
  });

  it("rejects a request naming another teacher as the owner", async () => {
    expect(
      await failureOf(() =>
        asA((tx) =>
          tx.execute(
            sql.raw(
              `insert into generation_requests (id, owner_id) values ('${fid(1, 901)}', '${USER_B}')`,
            ),
          ),
        ),
      ),
    ).toMatch(/row-level security/i);
  });

  it("does not let a teacher update or delete requests at all", async () => {
    for (const statement of [
      `update generation_requests set status = 'succeeded'`,
      `delete from generation_requests`,
    ]) {
      expect(await failureOf(() => asA((tx) => tx.execute(sql.raw(statement))))).toMatch(
        /permission denied/i,
      );
    }
  });
});

describe("questions", () => {
  it("owner A reads her own question and B gets 0 rows for it", async () => {
    const query = `select id from questions where id = '${FIXTURE.question(1)}'`;
    expect(await asA((tx) => rows(tx, query))).toEqual([{ id: FIXTURE.question(1) }]);
    expect(await asB((tx) => rows(tx, query))).toEqual([]);
  });

  it("A cannot update a non-granted column of her own row", async () => {
    expect(
      await failureOf(() =>
        asA((tx) =>
          tx.execute(
            sql.raw(
              `update questions set difficulty = 'sulit' where id = '${FIXTURE.question(1)}'`,
            ),
          ),
        ),
      ),
    ).toMatch(/permission denied/i);
  });

  it("lets the owner change the approval columns", async () => {
    const result = await asA((tx) =>
      rows(
        tx,
        `update questions set status = 'approved', approved_at = now(), approved_version_id = '${FIXTURE.version(1)}', row_version = row_version + 1, updated_at = now() where id = '${FIXTURE.question(1)}' returning id`,
      ),
    );
    expect(result).toHaveLength(1);
  });

  it("grants UPDATE on exactly the seven approval columns and nothing else", async () => {
    const granted = await ownerRows(
      `select column_name from information_schema.column_privileges
       where table_schema = 'public' and table_name = 'questions'
         and grantee = 'authenticated' and privilege_type = 'UPDATE'
       order by column_name`,
    );
    expect(granted.map((r) => r.column_name)).toEqual(
      [
        "approval_override",
        "approved_at",
        "approved_version_id",
        "banked_at",
        "row_version",
        "status",
        "updated_at",
      ].sort(),
    );
  });

  it("rejects an update of every other column", async () => {
    const approvalColumns = [
      "approval_override",
      "status",
      "approved_version_id",
      "approved_at",
      "banked_at",
      "row_version",
      "updated_at",
    ];
    const all = await ownerRows(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'questions' order by ordinal_position`,
    );
    const others = all
      .map((r) => String(r.column_name))
      .filter((name) => !approvalColumns.includes(name));
    // Guard against a vacuous loop: the table has columns beyond the seven approval ones.
    expect(others.length).toBeGreaterThan(0);
    expect(others).toEqual(
      expect.arrayContaining(["id", "owner_id", "grade", "difficulty", "topic_id"]),
    );
    for (const column of others) {
      expect(
        await failureOf(() =>
          asA((tx) =>
            tx.execute(
              sql.raw(
                `update questions set "${column}" = "${column}" where id = '${FIXTURE.question(1)}'`,
              ),
            ),
          ),
        ),
        column,
      ).toMatch(/permission denied/i);
    }
  });
  it("does not let another teacher update the row (RLS filters it out)", async () => {
    const result = await asB((tx) =>
      rows(
        tx,
        `update questions set status = 'archived' where id = '${FIXTURE.question(1)}' returning id`,
      ),
    );
    expect(result).toHaveLength(0);
  });

  it("does not let a teacher insert or delete questions", async () => {
    for (const statement of [
      `insert into questions default values`,
      `delete from questions`,
    ]) {
      expect(await failureOf(() => asA((tx) => tx.execute(sql.raw(statement))))).toMatch(
        /permission denied/i,
      );
    }
  });
});

describe("profiles", () => {
  it("lets a teacher update only their own profile", async () => {
    const own = await asA((tx) =>
      rows(
        tx,
        `update profiles set display_name = 'Bu A' where id = '${USER_A}' returning id`,
      ),
    );
    expect(own).toHaveLength(1);
    const other = await asA((tx) =>
      rows(
        tx,
        `update profiles set display_name = 'hacked' where id = '${USER_B}' returning id`,
      ),
    );
    expect(other).toHaveLength(0);
  });

  it("does not let a teacher delete a profile", async () => {
    expect(
      await failureOf(() =>
        asA((tx) => tx.execute(sql.raw(`delete from profiles where id = '${USER_A}'`))),
      ),
    ).toMatch(/permission denied/i);
  });

  it("rejects creating a profile for someone else", async () => {
    expect(
      await failureOf(() =>
        asA((tx) =>
          tx.execute(sql.raw(`insert into profiles (id) values ('${fid(1, 902)}')`)),
        ),
      ),
    ).toMatch(/row-level security/i);
  });
});

describe("question_versions immutability", () => {
  it("rejects an update even from the owner connection", async () => {
    expect(
      await failureOf(() =>
        database.db.execute(
          sql.raw(
            `update question_versions set stem_md = 'changed' where id = '${FIXTURE.version(1)}'`,
          ),
        ),
      ),
    ).toMatch(/immutable/i);
  });

  it("raises restrict_violation (SQLSTATE 23001) for the table owner", async () => {
    expect(
      await sqlstateOf(() =>
        database.db.execute(
          sql.raw(
            `update question_versions set stem_md = 'changed' where id = '${FIXTURE.version(1)}'`,
          ),
        ),
      ),
    ).toBe("23001");
  });

  it("does not let a teacher update or delete a version", async () => {
    for (const statement of [
      `update question_versions set stem_md = 'x'`,
      `delete from question_versions`,
    ]) {
      expect(await failureOf(() => asA((tx) => tx.execute(sql.raw(statement))))).toMatch(
        /permission denied/i,
      );
    }
  });
});

describe("assessment tables (teacher-written, Ruling R1)", () => {
  it.each(ASSESSMENT_TABLES)(
    "%s: RLS has owner select, insert, update and delete policies, with USING and WITH CHECK on owner_id",
    async (table) => {
      const result = await ownerRows(
        `select cmd, qual, with_check from pg_policies where tablename = '${table}' order by cmd`,
      );
      expect(result.map((r) => r.cmd)).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
      const owner = /owner_id = auth\.uid\(\)/;
      for (const row of result as { cmd: string; qual: unknown; with_check: unknown }[]) {
        if (row.cmd !== "INSERT") {
          expect(String(row.qual), `${table} ${row.cmd}`).toMatch(owner);
        }
        if (row.cmd === "INSERT" || row.cmd === "UPDATE") {
          expect(String(row.with_check), `${table} ${row.cmd}`).toMatch(owner);
        }
      }
    },
  );

  it.each(ASSESSMENT_TABLES)(
    "%s: a teacher cannot update or delete another teacher's row (0 rows)",
    async (table) => {
      const other = ROW_ID[table](2);
      expect(
        await asA((tx) =>
          rows(
            tx,
            `update ${q(table)} set updated_at = now() where id = '${other}' returning id`,
          ),
        ),
      ).toEqual([]);
      const remove = `delete from ${q(table)} where id = '${other}' returning id`;
      if (HARD_DELETE_REVOKED.includes(table)) {
        expect(await failureOf(() => asA((tx) => rows(tx, remove)))).toMatch(
          /permission denied/i,
        );
      } else {
        expect(await asA((tx) => rows(tx, remove))).toEqual([]);
      }
    },
  );

  it.each(ASSESSMENT_TABLES)(
    "%s: id, owner_id and created_at are not updatable",
    async (table) => {
      for (const column of ["id", "owner_id", "created_at"]) {
        expect(
          await failureOf(() =>
            asA((tx) =>
              tx.execute(
                sql.raw(
                  `update ${q(table)} set "${column}" = "${column}" where id = '${ROW_ID[table](1)}'`,
                ),
              ),
            ),
          ),
          `${table}.${column}`,
        ).toMatch(/permission denied/i);
      }
    },
  );

  it("grants column-level UPDATE on exactly the editable columns", async () => {
    const granted = await ownerRows(
      `select table_name, string_agg(column_name, ',' order by column_name) as columns
       from information_schema.column_privileges
       where table_schema = 'public' and grantee = 'authenticated' and privilege_type = 'UPDATE'
         and table_name in ('school_templates', 'assessments', 'assessment_sections', 'assessment_items')
       group by table_name order by table_name`,
    );
    const sorted = (columns: string[]) => [...columns].sort().join(",");
    expect(Object.fromEntries(granted.map((r) => [r.table_name, r.columns]))).toEqual({
      assessment_items: sorted([
        "section_id",
        "question_version_id",
        "sort_order",
        "points",
        "updated_at",
      ]),
      assessment_sections: sorted([
        "title",
        "instructions_md",
        "sort_order",
        "updated_at",
      ]),
      assessments: sorted([
        "title",
        "kind",
        "grade",
        "template_id",
        "exam_date",
        "duration_minutes",
        "instructions_md",
        "scoring_mode",
        "shuffle_seed",
        "status",
        "approved_at",
        "approved_snapshot_hash",
        "row_version",
        "updated_at",
      ]),
      school_templates: sorted([
        "name",
        "school_name",
        "header_lines",
        "subject",
        "student_fields",
        "default_instructions_md",
        "paper_size",
        "font",
        "is_default",
        "row_version",
        "updated_at",
      ]),
    });
  });

  it("never lets a teacher write a template's logo_key (only the upload path does)", async () => {
    // Pointing logo_key at another owner's object would turn every reader of the column into an
    // IDOR; the server writes it through the service connection with explicit owner filters.
    const foreignKey = `templates/${USER_B}/x/logo.png`;
    expect(
      await failureOf(() =>
        asA((tx) =>
          tx.execute(
            sql.raw(
              `update school_templates set logo_key = '${foreignKey}' where id = '${FIXTURE.template(1)}'`,
            ),
          ),
        ),
      ),
    ).toMatch(/permission denied/i);
    expect(
      await failureOf(() =>
        asA((tx) =>
          tx.execute(
            sql.raw(
              `insert into school_templates (owner_id, name, school_name, logo_key) values ('${USER_A}', 'x', 'x', '${foreignKey}')`,
            ),
          ),
        ),
      ),
    ).toMatch(/row-level security/i);
    // The other columns stay editable.
    expect(
      await asA((tx) =>
        rows(
          tx,
          `update school_templates set school_name = school_name, row_version = row_version where id = '${FIXTURE.template(1)}' returning id`,
        ),
      ),
    ).toEqual([{ id: FIXTURE.template(1) }]);
  });

  it("never lets a teacher insert a template or an assessment with trash dates or a logo hash", async () => {
    // A row inserted already trashed without purge_after would be hidden from the list and the
    // trash and never purged; trash dates are written by the server only (20261120050000).
    const statements = [
      `insert into school_templates (owner_id, name, school_name, deleted_at) values ('${USER_A}', 'x', 'x', now())`,
      `insert into school_templates (owner_id, name, school_name, purge_after) values ('${USER_A}', 'x', 'x', now())`,
      `insert into school_templates (owner_id, name, school_name, logo_sha256) values ('${USER_A}', 'x', 'x', '${"a".repeat(64)}')`,
      `insert into school_templates (owner_id, name, school_name, logo_bytes) values ('${USER_A}', 'x', 'x', 1)`,
      `insert into assessments (owner_id, title, kind, grade, deleted_at) values ('${USER_A}', 'x', 'latihan', 7, now())`,
      `insert into assessments (owner_id, title, kind, grade, purge_after) values ('${USER_A}', 'x', 'latihan', 7, now())`,
    ];
    for (const statement of statements) {
      expect(
        await failureOf(() => asA((tx) => tx.execute(sql.raw(statement)))),
        statement,
      ).toMatch(/row-level security/i);
    }
    // Nor may she write the logo hash later (only the upload path does, with logo_key).
    expect(
      await failureOf(() =>
        asA((tx) =>
          tx.execute(
            sql.raw(
              `update school_templates set logo_sha256 = null where id = '${FIXTURE.template(1)}'`,
            ),
          ),
        ),
      ),
    ).toMatch(/permission denied/i);
    // Nor the logo size the app-wide storage total sums (ADR-0022), nor the other two sizes.
    for (const statement of [
      `update school_templates set logo_bytes = 0 where id = '${FIXTURE.template(1)}'`,
      `update exports set size_bytes = 0 where id = '${FIXTURE.export(1)}'`,
      `update solver_sessions set input_bytes = 0 where id = '${FIXTURE.solverSession(1)}'`,
    ]) {
      expect(
        await failureOf(() => asA((tx) => tx.execute(sql.raw(statement)))),
        statement,
      ).toMatch(/permission denied/i);
    }
  });

  it("lets a teacher create and edit her own template, assessment, section and item, and delete sections and items", async () => {
    const template = fid(1, 950);
    const assessment = fid(1, 951);
    const section = fid(1, 952);
    const item = fid(1, 953);
    await asA(async (tx) => {
      await tx.execute(
        sql.raw(
          `insert into school_templates (id, owner_id, name, school_name) values ('${template}', '${USER_A}', 'Kedua', 'SMP A')`,
        ),
      );
      await tx.execute(
        sql.raw(
          `insert into assessments (id, owner_id, title, kind, grade, template_id) values ('${assessment}', '${USER_A}', 'Latihan', 'latihan', 7, '${template}')`,
        ),
      );
      await tx.execute(
        sql.raw(
          `insert into assessment_sections (id, owner_id, assessment_id, title, sort_order) values ('${section}', '${USER_A}', '${assessment}', 'A', 0)`,
        ),
      );
      await tx.execute(
        sql.raw(
          `insert into assessment_items (id, owner_id, assessment_id, section_id, question_id, question_version_id, sort_order, points)
           values ('${item}', '${USER_A}', '${assessment}', '${section}', '${FIXTURE.question(1)}', '${FIXTURE.version(1)}', 0, 2.5)`,
        ),
      );
      await tx.execute(
        sql.raw(
          `update assessments set title = 'Latihan 2', row_version = row_version + 1 where id = '${assessment}'`,
        ),
      );
    });
    expect(
      await asA((tx) =>
        rows(tx, `select title, row_version from assessments where id = '${assessment}'`),
      ),
    ).toEqual([{ title: "Latihan 2", row_version: 2 }]);
    const deleted = await asA(async (tx) => {
      await tx.execute(sql.raw(`delete from assessment_items where id = '${item}'`));
      return rows(
        tx,
        `delete from assessment_sections where id = '${section}' returning id`,
      );
    });
    expect(deleted).toEqual([{ id: section }]);
    // Assessments and templates go only through the trash (service connection, with their files).
    for (const statement of [
      `delete from assessments where id = '${assessment}'`,
      `delete from school_templates where id = '${template}'`,
      `update assessments set deleted_at = now() where id = '${assessment}'`,
      `update school_templates set purge_after = now() where id = '${template}'`,
    ]) {
      expect(
        await failureOf(() => asA((tx) => tx.execute(sql.raw(statement)))),
        statement,
      ).toMatch(/permission denied/i);
    }
    await ownerRows(`delete from assessments where id = '${assessment}'`);
    await ownerRows(`delete from school_templates where id = '${template}'`);
  });

  it.each([
    [
      "school_templates",
      `insert into school_templates (id, owner_id, name, school_name) values ('${fid(1, 960)}', '${USER_B}', 'x', 'x')`,
    ],
    [
      "assessments",
      `insert into assessments (id, owner_id, title, kind, grade) values ('${fid(1, 961)}', '${USER_B}', 'x', 'latihan', 7)`,
    ],
    [
      "assessment_sections",
      `insert into assessment_sections (id, owner_id, assessment_id, title, sort_order) values ('${fid(1, 962)}', '${USER_B}', '${FIXTURE.assessment(2)}', 'x', 5)`,
    ],
    [
      "assessment_items",
      `insert into assessment_items (id, owner_id, assessment_id, section_id, question_id, question_version_id, sort_order)
       values ('${fid(1, 963)}', '${USER_B}', '${FIXTURE.assessment(2)}', '${FIXTURE.section(2)}', '${FIXTURE.question(2)}', '${FIXTURE.version(2)}', 5)`,
    ],
  ])(
    "%s: rejects a row naming another teacher as the owner",
    async (_table, statement) => {
      expect(await failureOf(() => asA((tx) => tx.execute(sql.raw(statement))))).toMatch(
        /row-level security/i,
      );
    },
  );

  it("allows one default template per owner, not counting trashed ones", async () => {
    const insert = (id: string, deleted: boolean) =>
      database.db.execute(
        sql.raw(
          `insert into school_templates (id, owner_id, name, school_name, is_default, deleted_at)
           values ('${id}', '${USER_A}', 'x', 'x', true, ${deleted ? "now()" : "null"})`,
        ),
      );
    expect(await failureOf(() => insert(fid(1, 970), false))).toMatch(
      /school_templates_one_default_per_owner/,
    );
    // A trashed default does not count, and the other owner keeps her own default.
    await insert(fid(1, 971), true);
    expect(
      await ownerRows(
        `select owner_id from school_templates where is_default and deleted_at is null order by owner_id`,
      ),
    ).toEqual([{ owner_id: USER_A }, { owner_id: USER_B }]);
  });

  it.each([
    ["assessments", "kind", "'ujian_nasional'"],
    ["assessments", "scoring_mode", "'random'"],
    ["assessments", "status", "'published'"],
    ["assessments", "grade", "10"],
    ["assessments", "duration_minutes", "0"],
    ["school_templates", "paper_size", "'Letter'"],
    ["school_templates", "font", "'comic'"],
    ["exports", "document", "'answers'"],
    ["exports", "format", "'odt'"],
    ["assessment_items", "points", "-1"],
  ])("%s.%s rejects %s", async (table, column, value) => {
    expect(
      await failureOf(() =>
        database.db.execute(
          sql.raw(
            `update ${q(table)} set "${column}" = ${value} where id = '${ROW_ID[table](1)}'`,
          ),
        ),
      ),
    ).toMatch(/check constraint/i);
  });

  it("rejects an export whose format does not match its document", async () => {
    expect(
      await failureOf(() =>
        database.db.execute(
          sql.raw(`update exports set format = 'zip' where id = '${FIXTURE.export(1)}'`),
        ),
      ),
    ).toMatch(/exports_zip_format_check/);
  });

  it("rejects an approved assessment without its approval time and snapshot hash", async () => {
    expect(
      await failureOf(() =>
        database.db.execute(
          sql.raw(
            `update assessments set status = 'approved' where id = '${FIXTURE.assessment(1)}'`,
          ),
        ),
      ),
    ).toMatch(/assessments_approved_check/);
  });

  it("records one usage per assessment, export and question version", async () => {
    expect(
      await failureOf(() =>
        database.db.execute(
          sql.raw(
            `insert into question_usages (owner_id, question_id, question_version_id, assessment_id, export_id)
             values ('${USER_A}', '${FIXTURE.question(1)}', '${FIXTURE.version(1)}', '${FIXTURE.assessment(1)}', '${FIXTURE.export(1)}')`,
          ),
        ),
      ),
    ).toMatch(/question_usages_once_per_export/);
  });

  it("does not let a teacher write exports or usages (the export job does)", async () => {
    for (const statement of [
      `insert into exports (owner_id, assessment_id, document, format, object_key, snapshot_hash, expires_at)
       values ('${USER_A}', '${FIXTURE.assessment(1)}', 'paper', 'pdf', 'k', 'h', now())`,
      `insert into question_usages (owner_id, question_id, question_version_id, assessment_id)
       values ('${USER_A}', '${FIXTURE.question(1)}', '${FIXTURE.version(1)}', '${FIXTURE.assessment(1)}')`,
    ]) {
      expect(await failureOf(() => asA((tx) => tx.execute(sql.raw(statement))))).toMatch(
        /permission denied/i,
      );
    }
  });
});

describe("composite owner foreign keys", () => {
  it("rejects attaching a request to another owner's job", async () => {
    expect(
      await failureOf(() =>
        database.db.execute(
          sql.raw(
            `insert into generation_requests (id, owner_id, job_id) values ('${fid(1, 903)}', '${USER_A}', '${FIXTURE.job(2)}')`,
          ),
        ),
      ),
    ).toMatch(/foreign key/i);
  });

  it("rejects a source row whose version belongs to another owner", async () => {
    expect(
      await failureOf(() =>
        database.db.execute(
          sql.raw(
            `insert into question_sources (id, owner_id, question_version_id) values ('${fid(1, 904)}', '${USER_A}', '${FIXTURE.version(2)}')`,
          ),
        ),
      ),
    ).toMatch(/foreign key/i);
  });

  describe("assessment tables", () => {
    // A second question of A with no item yet, and a second assessment of A with no section: each
    // case below breaks exactly one constraint, named in the expectation.
    const OTHER_QUESTION = fid(1, 990);
    const OTHER_ASSESSMENT = fid(1, 981);

    beforeAll(async () => {
      await database.db.execute(
        sql.raw(
          `insert into questions (id, owner_id, grade, difficulty, topic_id) values ('${OTHER_QUESTION}', '${USER_A}', 8, 'mudah', '${FIXTURE.topic}')`,
        ),
      );
      await database.db.execute(
        sql.raw(
          `insert into assessments (id, owner_id, title, kind, grade) values ('${OTHER_ASSESSMENT}', '${USER_A}', 'Kedua', 'latihan', 8)`,
        ),
      );
    });

    const item = (values: {
      assessment: string;
      section: string;
      question: string;
      version: string;
    }) =>
      `insert into assessment_items (owner_id, assessment_id, section_id, question_id, question_version_id, sort_order)
       values ('${USER_A}', '${values.assessment}', '${values.section}', '${values.question}', '${values.version}', 9)`;

    it.each([
      [
        "an item of A pinning B's question version",
        item({
          assessment: FIXTURE.assessment(1),
          section: FIXTURE.section(1),
          question: OTHER_QUESTION,
          version: FIXTURE.version(2),
        }),
        "assessment_items_version_owner_fk",
      ],
      [
        "an item of A pinning a version of a different question of A",
        item({
          assessment: FIXTURE.assessment(1),
          section: FIXTURE.section(1),
          question: OTHER_QUESTION,
          version: FIXTURE.version(1),
        }),
        "assessment_items_version_owner_fk",
      ],
      [
        "an item of A in a section of another assessment of A",
        item({
          assessment: OTHER_ASSESSMENT,
          section: FIXTURE.section(1),
          question: FIXTURE.question(1),
          version: FIXTURE.version(1),
        }),
        "assessment_items_section_owner_fk",
      ],
      [
        // The section reference includes the assessment, so it fails too; Postgres reports the
        // first constraint checked, the assessment one (created first).
        "an item of A in B's assessment",
        item({
          assessment: FIXTURE.assessment(2),
          section: FIXTURE.section(2),
          question: FIXTURE.question(1),
          version: FIXTURE.version(1),
        }),
        "assessment_items_assessment_owner_fk",
      ],
      [
        "an assessment of A on B's template",
        `insert into assessments (owner_id, title, kind, grade, template_id)
         values ('${USER_A}', 'x', 'latihan', 7, '${FIXTURE.template(2)}')`,
        "assessments_template_owner_fk",
      ],
      [
        "a section of A in B's assessment",
        `insert into assessment_sections (owner_id, assessment_id, title, sort_order)
         values ('${USER_A}', '${FIXTURE.assessment(2)}', 'x', 1)`,
        "assessment_sections_assessment_owner_fk",
      ],
      [
        "an export of A of B's assessment",
        `insert into exports (owner_id, assessment_id, document, format, object_key, snapshot_hash, expires_at)
         values ('${USER_A}', '${FIXTURE.assessment(2)}', 'paper', 'pdf', 'k', 'h', now())`,
        "exports_assessment_owner_fk",
      ],
      [
        "an export of A on B's job",
        `insert into exports (owner_id, assessment_id, document, format, object_key, snapshot_hash, expires_at, job_id)
         values ('${USER_A}', '${FIXTURE.assessment(1)}', 'paper', 'pdf', 'k', 'h', now(), '${FIXTURE.job(2)}')`,
        "exports_job_owner_fk",
      ],
      [
        "a usage of A naming B's export",
        `insert into question_usages (owner_id, question_id, question_version_id, assessment_id, export_id)
         values ('${USER_A}', '${FIXTURE.question(1)}', '${FIXTURE.version(1)}', '${FIXTURE.assessment(1)}', '${FIXTURE.export(2)}')`,
        "question_usages_export_owner_fk",
      ],
      [
        "a usage of A naming B's assessment",
        `insert into question_usages (owner_id, question_id, question_version_id, assessment_id)
         values ('${USER_A}', '${FIXTURE.question(1)}', '${FIXTURE.version(1)}', '${FIXTURE.assessment(2)}')`,
        "question_usages_assessment_owner_fk",
      ],
    ])("rejects %s", async (_label, statement, constraint) => {
      expect(await sqlstateOf(() => database.db.execute(sql.raw(statement)))).toBe(
        "23503",
      );
      expect(await failureOf(() => database.db.execute(sql.raw(statement)))).toMatch(
        new RegExp(`"${constraint}"`),
      );
    });
  });

  it("rejects pointing a question's current version at another owner's version", async () => {
    expect(
      await failureOf(() =>
        database.db.execute(
          sql.raw(
            `update questions set current_version_id = '${FIXTURE.version(2)}' where id = '${FIXTURE.question(1)}'`,
          ),
        ),
      ),
    ).toMatch(/foreign key/i);
  });
});

describe("destructive scenarios (fresh database each)", () => {
  it(
    "deleting a user cascades through their profile and every owned row",
    async () => {
      const fresh = await createTestDatabase();
      try {
        await seedFixtures(fresh.db);
        await fresh.db.execute(sql.raw(`delete from "user" where id = '${USER_A}'`));
        for (const table of [
          "profiles",
          "session",
          "account",
          "jobs",
          "job_runs",
          "generation_requests",
          "generation_runs",
          "questions",
          "question_versions",
          "question_sources",
          "verification_runs",
          "ai_calls",
          "audit_log",
          "usage_events",
          "school_templates",
          "assessments",
          "assessment_sections",
          "assessment_items",
          "exports",
          "question_usages",
          "folders",
          "materials",
          "material_sections",
          "material_pages",
          "ocr_usage",
          "material_uploads",
          "solver_sessions",
          "solver_solutions",
        ]) {
          const ownerColumn =
            table === "profiles"
              ? "id"
              : AUTH_TABLES.includes(table)
                ? "user_id"
                : "owner_id";
          const left = await fresh.db.execute(
            sql.raw(
              `select count(*)::int as n from ${q(table)} where ${ownerColumn} = '${USER_A}'`,
            ),
          );
          expect(
            (left.rows[0] as { n: number }).n,
            `${table} should be empty for A`,
          ).toBe(0);
          const kept = await fresh.db.execute(
            sql.raw(
              `select count(*)::int as n from ${q(table)} where ${ownerColumn} = '${USER_B}'`,
            ),
          );
          expect((kept.rows[0] as { n: number }).n, `${table} should keep B's rows`).toBe(
            1,
          );
        }
        const orphaned = await fresh.db.execute(
          sql.raw(`select owner_id from app_errors where id = '${FIXTURE.appError(1)}'`),
        );
        expect(orphaned.rows[0]).toEqual({ owner_id: null });
      } finally {
        await fresh.client.close();
      }
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses to delete a question pinned by an assessment item (Ruling R2), and allows it once the assessment is gone",
    async () => {
      const fresh = await createTestDatabase();
      try {
        await seedFixtures(fresh.db);
        const deleteQuestion = () =>
          fresh.db.execute(
            sql.raw(
              `delete from questions where id = '${FIXTURE.question(1)}' returning id`,
            ),
          );
        expect(await failureOf(deleteQuestion)).toMatch(/assessment_items_\w+_fk/);
        await fresh.db.execute(
          sql.raw(`delete from assessments where id = '${FIXTURE.assessment(1)}'`),
        );
        expect((await deleteQuestion()).rows).toEqual([{ id: FIXTURE.question(1) }]);
      } finally {
        await fresh.client.close();
      }
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "keeps the usage history when an expired export row is purged (export_id set to null)",
    async () => {
      const fresh = await createTestDatabase();
      try {
        await seedFixtures(fresh.db);
        await fresh.db.execute(
          sql.raw(`delete from exports where id = '${FIXTURE.export(1)}'`),
        );
        const left = await fresh.db.execute(
          sql.raw(
            `select owner_id, export_id from question_usages where id = '${FIXTURE.questionUsage(1)}'`,
          ),
        );
        expect(left.rows).toEqual([{ owner_id: USER_A, export_id: null }]);
      } finally {
        await fresh.client.close();
      }
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a table created after the migrations is deny-by-default for teachers",
    async () => {
      const fresh = await createTestDatabase();
      try {
        await fresh.db.execute(sql.raw(`create table zz_future (id int, owner_id uuid)`));
        expect(
          await failureOf(() =>
            runAsUser(fresh.db, USER_A, (tx) =>
              tx.execute(sql.raw(`select * from zz_future`)),
            ),
          ),
        ).toMatch(/permission denied/i);
      } finally {
        await fresh.client.close();
      }
    },
    DB_TEST_TIMEOUT,
  );
});

describe("completeness guard", () => {
  it("lists every table in the public schema in exactly one group", async () => {
    const result = await database.db.execute(
      sql.raw(
        `select tablename from pg_tables where schemaname = 'public' and tablename not like '\\_\\_%' order by tablename`,
      ),
    );
    const actual = (result.rows as { tablename: string }[]).map((r) => r.tablename);
    const listed = [
      ...CURRICULUM,
      ...WRITABLE,
      ...ASSESSMENT_TABLES,
      ...MATERIAL_TABLES,
      ...READ_ONLY,
      ...NO_ACCESS,
    ].sort();
    expect(listed).toEqual(actual);
    expect(new Set(listed).size).toBe(listed.length);
  });
});
