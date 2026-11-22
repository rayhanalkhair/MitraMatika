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

// The materials and solver tables (Task 2 of the materials plan): RLS, grants, server-only
// columns, composite owner foreign keys, the folder nesting rule, the page search vector, the
// daily OCR counter and the material citations of question_sources.

const MATERIAL_TABLES = [
  "folders",
  "materials",
  "material_sections",
  "material_pages",
  "ocr_usage",
  "solver_sessions",
  "solver_solutions",
];

function errorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(" | ");
}

async function failureOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return errorChain(error);
  }
  throw new Error("expected the statement to fail, but it succeeded");
}

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

let database: TestDatabase;
type Tx = Parameters<Parameters<TestDatabase["db"]["transaction"]>[0]>[0];
const asA = <T>(fn: (tx: Tx) => Promise<T>) => runAsUser(database.db, USER_A, fn);
const rows = async (tx: Tx, query: string) => (await tx.execute(sql.raw(query))).rows;
const ownerRows = async (query: string) =>
  (await database.db.execute(sql.raw(query))).rows;
const asTeacher = (statement: string) => () =>
  asA((tx) => tx.execute(sql.raw(statement)));

beforeAll(async () => {
  database = await createTestDatabase();
  await seedFixtures(database.db);
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await database.client.close();
});

describe("materials tables: RLS and policies", () => {
  it.each(MATERIAL_TABLES)("%s has row level security enabled", async (table) => {
    const [row] = await ownerRows(
      `select relrowsecurity as rls from pg_class where oid = 'public.${table}'::regclass`,
    );
    expect(row).toEqual({ rls: true });
  });

  it("gives each table owner policies only for the verbs a teacher has", async () => {
    const result = await ownerRows(
      `select tablename, string_agg(cmd, ',' order by cmd) as cmds from pg_policies
       where tablename in (${MATERIAL_TABLES.map((t) => `'${t}'`).join(", ")})
       group by tablename order by tablename`,
    );
    expect(Object.fromEntries(result.map((r) => [r.tablename, r.cmds]))).toEqual({
      folders: "INSERT,SELECT,UPDATE",
      material_pages: "SELECT",
      material_sections: "DELETE,INSERT,SELECT,UPDATE",
      materials: "SELECT,UPDATE",
      ocr_usage: "SELECT",
      solver_sessions: "SELECT",
      solver_solutions: "SELECT",
    });
  });

  it("checks owner_id = auth.uid() in USING and WITH CHECK of every policy", async () => {
    const result = (await ownerRows(
      `select tablename, cmd, qual, with_check from pg_policies
       where tablename in (${MATERIAL_TABLES.map((t) => `'${t}'`).join(", ")})`,
    )) as { tablename: string; cmd: string; qual: unknown; with_check: unknown }[];
    const owner = /owner_id = auth\.uid\(\)/;
    expect(result.length).toBeGreaterThan(0);
    for (const row of result) {
      if (row.cmd !== "INSERT") expect(String(row.qual), row.tablename).toMatch(owner);
      if (row.cmd === "INSERT" || row.cmd === "UPDATE") {
        expect(String(row.with_check), `${row.tablename} ${row.cmd}`).toMatch(owner);
      }
    }
  });

  it("grants column-level UPDATE on exactly the teacher-editable columns", async () => {
    const granted = await ownerRows(
      `select table_name, string_agg(column_name, ',' order by column_name) as columns
       from information_schema.column_privileges
       where table_schema = 'public' and grantee = 'authenticated' and privilege_type = 'UPDATE'
         and table_name in (${MATERIAL_TABLES.map((t) => `'${t}'`).join(", ")})
       group by table_name order by table_name`,
    );
    const sorted = (columns: string[]) => [...columns].sort().join(",");
    expect(Object.fromEntries(granted.map((r) => [r.table_name, r.columns]))).toEqual({
      folders: sorted(["name", "parent_id", "updated_at"]),
      material_sections: sorted([
        "parent_id",
        "title",
        "kind",
        "page_start",
        "page_end",
        "topic_id",
        "updated_at",
      ]),
      materials: sorted(["title", "folder_id", "grade", "academic_year", "updated_at"]),
    });
  });
});

describe("server-only columns and tables", () => {
  it.each([
    ["materials", "status", "'ready'"],
    ["materials", "object_key", `'materials/${USER_B}/x/file.pdf'`],
    ["materials", "sha256", `'${"b".repeat(64)}'`],
    ["materials", "page_count", "2"],
    ["materials", "kind", "'docx'"],
    ["materials", "mime", "'text/html'"],
    ["materials", "size_bytes", "1"],
    ["materials", "proposed_metadata", "'{}'"],
    ["materials", "metadata_confirmed_at", "now()"],
    ["materials", "deleted_at", "now()"],
    ["materials", "purge_after", "now()"],
    ["materials", "owner_id", "owner_id"],
    ["folders", "deleted_at", "now()"],
    ["folders", "purge_after", "now()"],
    ["folders", "owner_id", "owner_id"],
    ["material_sections", "material_id", "material_id"],
    ["material_sections", "owner_id", "owner_id"],
    ["material_pages", "text_md", "'diubah'"],
    ["material_pages", "text_source", "'manual'"],
    ["material_pages", "confidence", "'high'"],
    ["material_pages", "flags", "'[]'"],
    ["material_pages", "ocr_status", "'queued'"],
    ["material_pages", "reviewed_at", "now()"],
    ["material_pages", "image_bytes", "1"],
    ["ocr_usage", "pages", "0"],
    ["solver_sessions", "status", "'ready'"],
    ["solver_sessions", "confirmed_md", "'x'"],
    ["solver_sessions", "input_key", `'solver/${USER_B}/x.png'`],
    ["solver_sessions", "deleted_at", "now()"],
    ["solver_sessions", "photo_sweep_attempted_at", "now()"],
    ["solver_solutions", "verification_status", "'terverifikasi'"],
    ["solver_solutions", "verification_report", "'{}'"],
  ])("a teacher cannot update %s.%s", async (table, column, value) => {
    const ids: Record<string, string> = {
      materials: FIXTURE.material(1),
      folders: FIXTURE.folder(1),
      material_sections: FIXTURE.materialSection(1),
      material_pages: FIXTURE.materialPage(1),
      ocr_usage: FIXTURE.ocrUsage(1),
      solver_sessions: FIXTURE.solverSession(1),
      solver_solutions: FIXTURE.solverSolution(1),
    };
    const id = ids[table];
    if (!id) throw new Error(`no fixture row for ${table}`);
    expect(
      await failureOf(
        asTeacher(`update "${table}" set "${column}" = ${value} where id = '${id}'`),
      ),
    ).toMatch(/permission denied/i);
  });

  it("does not let a teacher edit a trashed folder or material", async () => {
    const folder = fid(1, 740);
    const material = fid(1, 741);
    await ownerRows(
      `insert into folders (id, owner_id, name, deleted_at, purge_after) values ('${folder}', '${USER_A}', 'Lama', now(), now() + interval '30 days')`,
    );
    await ownerRows(
      `insert into materials (id, owner_id, title, kind, mime, size_bytes, sha256, object_key, deleted_at, purge_after)
       values ('${material}', '${USER_A}', 'Lama', 'pdf', 'application/pdf', 1, '${"f".repeat(64)}', 'materials/${USER_A}/${material}/file.pdf', now(), now() + interval '30 days')`,
    );
    expect(
      await asA((tx) =>
        rows(tx, `update folders set name = 'Baru' where id = '${folder}' returning id`),
      ),
    ).toEqual([]);
    expect(
      await asA((tx) =>
        rows(
          tx,
          `update materials set title = 'Baru' where id = '${material}' returning id`,
        ),
      ),
    ).toEqual([]);
    // The rows stay readable (the trash lists them).
    expect(
      await asA((tx) => rows(tx, `select title from materials where id = '${material}'`)),
    ).toEqual([{ title: "Lama" }]);
    const policies = await ownerRows(
      `select policyname, qual, with_check from pg_policies
       where policyname in ('folders_owner_update', 'materials_owner_update') order by policyname`,
    );
    expect(policies).toHaveLength(2);
    for (const policy of policies) {
      expect(String(policy.qual), String(policy.policyname)).toMatch(
        /deleted_at IS NULL/,
      );
      expect(String(policy.with_check), String(policy.policyname)).toMatch(
        /deleted_at IS NULL/,
      );
    }
  });

  it("does not let a teacher insert or delete materials (finalise and the trash do)", async () => {
    for (const statement of [
      `insert into materials (owner_id, title, kind, mime, size_bytes, sha256, object_key)
       values ('${USER_A}', 'x', 'pdf', 'application/pdf', 1, '${"c".repeat(64)}', 'materials/${USER_B}/y/file.pdf')`,
      `delete from materials where id = '${FIXTURE.material(1)}'`,
      `delete from folders where id = '${FIXTURE.folder(1)}'`,
    ]) {
      expect(await failureOf(asTeacher(statement)), statement).toMatch(
        /permission denied/i,
      );
    }
  });

  it("does not let a teacher insert or delete pages, OCR usage or solver rows", async () => {
    for (const table of [
      "material_pages",
      "ocr_usage",
      "solver_sessions",
      "solver_solutions",
    ]) {
      for (const statement of [
        `insert into "${table}" default values`,
        `delete from "${table}"`,
      ]) {
        expect(await failureOf(asTeacher(statement)), statement).toMatch(
          /permission denied/i,
        );
      }
    }
  });

  it("refuses a folder inserted with trash dates or for another teacher", async () => {
    for (const statement of [
      `insert into folders (owner_id, name, deleted_at) values ('${USER_A}', 'x', now())`,
      `insert into folders (owner_id, name, purge_after) values ('${USER_A}', 'x', now())`,
      `insert into folders (owner_id, name) values ('${USER_B}', 'x')`,
      `insert into material_sections (owner_id, material_id, title, page_start)
       values ('${USER_B}', '${FIXTURE.material(2)}', 'x', 1)`,
    ]) {
      expect(await failureOf(asTeacher(statement)), statement).toMatch(
        /row-level security/i,
      );
    }
  });

  it("lets a teacher create, rename and move folders, edit material metadata and manage sections", async () => {
    const parent = fid(1, 700);
    const child = fid(1, 701);
    const section = fid(1, 702);
    const subsection = fid(1, 703);
    await asA(async (tx) => {
      await tx.execute(
        sql.raw(
          `insert into folders (id, owner_id, name) values ('${parent}', '${USER_A}', 'Kelas 8'), ('${child}', '${USER_A}', 'Semester 1')`,
        ),
      );
      await tx.execute(
        sql.raw(
          `update folders set parent_id = '${parent}', name = 'Semester ganjil', updated_at = now() where id = '${child}'`,
        ),
      );
      await tx.execute(
        sql.raw(
          `update materials set title = 'Buku siswa', folder_id = '${child}', grade = 9, academic_year = '2025/2026', updated_at = now() where id = '${FIXTURE.material(1)}'`,
        ),
      );
      await tx.execute(
        sql.raw(
          `insert into material_sections (id, owner_id, material_id, title, kind, page_start, page_end)
           values ('${section}', '${USER_A}', '${FIXTURE.material(1)}', 'Bab 2', 'chapter', 1, 1),
                  ('${subsection}', '${USER_A}', '${FIXTURE.material(1)}', '2.1', 'section', 1, 1)`,
        ),
      );
      await tx.execute(
        sql.raw(
          `update material_sections set parent_id = '${section}', title = '2.1 Fungsi', topic_id = '${FIXTURE.topic}' where id = '${subsection}'`,
        ),
      );
    });
    expect(
      await asA((tx) =>
        rows(
          tx,
          `select f.name, f.parent_id, m.title, m.grade, m.academic_year from folders f
           join materials m on m.folder_id = f.id where m.id = '${FIXTURE.material(1)}'`,
        ),
      ),
    ).toEqual([
      {
        name: "Semester ganjil",
        parent_id: parent,
        title: "Buku siswa",
        grade: 9,
        academic_year: "2025/2026",
      },
    ]);
    // Deleting a chapter takes its subsections.
    expect(
      await asA((tx) =>
        rows(tx, `delete from material_sections where id = '${section}' returning id`),
      ),
    ).toEqual([{ id: section }]);
    expect(
      await ownerRows(`select id from material_sections where id = '${subsection}'`),
    ).toEqual([]);
    await ownerRows(
      `update materials set folder_id = '${FIXTURE.folder(1)}' where id = '${FIXTURE.material(1)}'`,
    );
    await ownerRows(`delete from folders where id in ('${child}', '${parent}')`);
  });
});

describe("page search vector", () => {
  it("is generated from text_md with the indonesian configuration and follows its updates", async () => {
    const page = FIXTURE.materialPage(1);
    const tsv = async () =>
      String(
        (
          await ownerRows(
            `select tsv::text as tsv from material_pages where id = '${page}'`,
          )
        )[0].tsv,
      );
    expect(await tsv()).toContain("'pola'");
    await ownerRows(
      `update material_pages set text_md = 'Persamaan linear dua variabel' where id = '${page}'`,
    );
    // "persamaan" stems to "sama" with the indonesian configuration.
    expect(await tsv()).toContain("'sama'");
    expect(await tsv()).not.toContain("'pola'");
    expect(
      await ownerRows(
        `select id from material_pages where tsv @@ to_tsquery('indonesian', 'persamaan') and id = '${page}'`,
      ),
    ).toEqual([{ id: page }]);
    expect(
      await failureOf(() =>
        ownerRows(
          `update material_pages set tsv = to_tsvector('x') where id = '${page}'`,
        ),
      ),
    ).toMatch(/can only be updated to DEFAULT/i);
    await ownerRows(
      `update material_pages set text_md = 'Pola bilangan ganjil' where id = '${page}'`,
    );
  });

  it("is indexed with GIN, and the page text with a trigram index", async () => {
    const result = await ownerRows(
      `select indexname, indexdef from pg_indexes where tablename = 'material_pages' order by indexname`,
    );
    const defs: Record<string, string> = Object.fromEntries(
      result.map((r) => [String(r.indexname), String(r.indexdef)]),
    );
    expect(defs.material_pages_tsv_idx).toMatch(/USING gin \(tsv\)/);
    expect(defs.material_pages_text_trgm).toMatch(/USING gin \(text_md gin_trgm_ops\)/);
    expect(defs.material_pages_material_page_unique).toMatch(
      /UNIQUE INDEX .*\(material_id, page_no\)/,
    );
  });
});

describe("cross-owner references", () => {
  // Each case breaks exactly one constraint, named in the expectation.
  it.each([
    [
      "a folder of A inside B's folder",
      `insert into folders (owner_id, name, parent_id) values ('${USER_A}', 'x', '${FIXTURE.folder(2)}')`,
      "folders_parent_owner_fk",
    ],
    [
      "a material of A in B's folder",
      `insert into materials (owner_id, folder_id, title, kind, mime, size_bytes, sha256, object_key)
       values ('${USER_A}', '${FIXTURE.folder(2)}', 'x', 'pdf', 'application/pdf', 1, '${"d".repeat(64)}', 'materials/a/1')`,
      "materials_folder_owner_fk",
    ],
    [
      "a section of A in B's material",
      `insert into material_sections (owner_id, material_id, title, page_start)
       values ('${USER_A}', '${FIXTURE.material(2)}', 'x', 1)`,
      "material_sections_material_owner_fk",
    ],
    [
      "a subsection of A under a section of another material",
      `insert into material_sections (owner_id, material_id, parent_id, title, page_start)
       values ('${USER_A}', '${FIXTURE.material(1)}', '${FIXTURE.materialSection(2)}', 'x', 1)`,
      "material_sections_parent_owner_fk",
    ],
    [
      "a page of A in B's material",
      `insert into material_pages (owner_id, material_id, page_no)
       values ('${USER_A}', '${FIXTURE.material(2)}', 9)`,
      "material_pages_material_owner_fk",
    ],
    [
      "a solution of A for B's session",
      `insert into solver_solutions (owner_id, session_id, method_label, steps, final_answer, verification_status)
       values ('${USER_A}', '${FIXTURE.solverSession(2)}', 'x', '[]', '{}', 'terverifikasi')`,
      "solver_solutions_session_owner_fk",
    ],
    [
      "a solution of A on B's generation run",
      `insert into solver_solutions (owner_id, session_id, method_label, steps, final_answer, verification_status, generation_run_id)
       values ('${USER_A}', '${FIXTURE.solverSession(1)}', 'x', '[]', '{}', 'terverifikasi', '${FIXTURE.run(2)}')`,
      "solver_solutions_run_owner_fk",
    ],
    [
      "a source of A citing B's material",
      `insert into question_sources (owner_id, question_version_id, kind, material_id, anchor_label, excerpt)
       values ('${USER_A}', '${FIXTURE.version(1)}', 'material', '${FIXTURE.material(2)}', 'hal. 1', 'x')`,
      "question_sources_material_owner_fk",
    ],
    [
      "a source of A citing B's page",
      `insert into question_sources (owner_id, question_version_id, kind, material_id, material_page_id, anchor_label, excerpt)
       values ('${USER_A}', '${FIXTURE.version(1)}', 'material', '${FIXTURE.material(1)}', '${FIXTURE.materialPage(2)}', 'hal. 1', 'x')`,
      "question_sources_page_material_owner_fk",
    ],
    [
      "a source of A citing B's section",
      `insert into question_sources (owner_id, question_version_id, kind, material_id, section_id, anchor_label, excerpt)
       values ('${USER_A}', '${FIXTURE.version(1)}', 'material', '${FIXTURE.material(1)}', '${FIXTURE.materialSection(2)}', 'hal. 1', 'x')`,
      "question_sources_section_material_owner_fk",
    ],
  ])("rejects %s", async (_label, statement, constraint) => {
    expect(await sqlstateOf(() => ownerRows(statement))).toBe("23503");
    expect(await failureOf(() => ownerRows(statement))).toMatch(
      new RegExp(`"${constraint}"`),
    );
  });
});

describe("references within one owner's materials", () => {
  // A second material of A, with a page and a section: each case pairs a reference from one
  // material with the other material, so only the material part of the constraint breaks.
  const OTHER_MATERIAL = fid(1, 730);
  const OTHER_PAGE = fid(1, 731);
  const OTHER_SECTION = fid(1, 732);

  beforeAll(async () => {
    await ownerRows(
      `insert into materials (id, owner_id, title, kind, mime, size_bytes, sha256, object_key)
       values ('${OTHER_MATERIAL}', '${USER_A}', 'Buku kedua', 'pdf', 'application/pdf', 1, '${"e".repeat(64)}', 'materials/${USER_A}/${OTHER_MATERIAL}/file.pdf')`,
    );
    await ownerRows(
      `insert into material_pages (id, owner_id, material_id, page_no) values ('${OTHER_PAGE}', '${USER_A}', '${OTHER_MATERIAL}', 1)`,
    );
    await ownerRows(
      `insert into material_sections (id, owner_id, material_id, title, page_start) values ('${OTHER_SECTION}', '${USER_A}', '${OTHER_MATERIAL}', 'Bab 1', 1)`,
    );
  });

  const source = (column: "material_page_id" | "section_id", value: string) =>
    `insert into question_sources (owner_id, question_version_id, kind, material_id, ${column}, anchor_label, excerpt)
     values ('${USER_A}', '${FIXTURE.version(1)}', 'material', '${FIXTURE.material(1)}', '${value}', 'hal. 1', 'x')`;

  it.each([
    [
      "a subsection under a section of another material",
      `insert into material_sections (owner_id, material_id, parent_id, title, page_start)
       values ('${USER_A}', '${FIXTURE.material(1)}', '${OTHER_SECTION}', 'x', 1)`,
      "material_sections_parent_owner_fk",
    ],
    [
      "a citation of a page of another material",
      source("material_page_id", OTHER_PAGE),
      "question_sources_page_material_owner_fk",
    ],
    [
      "a citation of a section of another material",
      source("section_id", OTHER_SECTION),
      "question_sources_section_material_owner_fk",
    ],
  ])("rejects %s", async (_label, statement, constraint) => {
    expect(await sqlstateOf(() => ownerRows(statement))).toBe("23503");
    expect(await failureOf(() => ownerRows(statement))).toMatch(
      new RegExp(`"${constraint}"`),
    );
  });

  it("accepts a citation of a page and a section of the cited material", async () => {
    await ownerRows(
      `insert into question_sources (owner_id, question_version_id, kind, material_id, material_page_id, section_id, anchor_label, excerpt)
       values ('${USER_A}', '${FIXTURE.version(1)}', 'material', '${OTHER_MATERIAL}', '${OTHER_PAGE}', '${OTHER_SECTION}', 'hal. 1', 'x')`,
    );
  });

  it.each([
    ["a page", "material_page_id", OTHER_PAGE],
    ["a section", "section_id", OTHER_SECTION],
  ])("rejects %s cited without its material", async (_label, column, value) => {
    const statement = `insert into question_sources (owner_id, question_version_id, kind, ${column}, anchor_label, excerpt)
       values ('${USER_A}', '${FIXTURE.version(1)}', 'material', '${value}', 'hal. 1', 'x')`;
    expect(await sqlstateOf(() => ownerRows(statement))).toBe("23514");
    expect(await failureOf(() => ownerRows(statement))).toMatch(
      /question_sources_material_pair_check/,
    );
  });

  it("clears the page and the section when the material reference is cleared", async () => {
    const id = fid(1, 733);
    await ownerRows(
      `insert into question_sources (id, owner_id, question_version_id, kind, material_id, material_page_id, section_id, anchor_label, excerpt)
       values ('${id}', '${USER_A}', '${FIXTURE.version(1)}', 'material', '${OTHER_MATERIAL}', '${OTHER_PAGE}', '${OTHER_SECTION}', 'hal. 1', 'x')`,
    );
    await ownerRows(`update question_sources set material_id = null where id = '${id}'`);
    expect(
      await ownerRows(
        `select material_id, material_page_id, section_id from question_sources where id = '${id}'`,
      ),
    ).toEqual([{ material_id: null, material_page_id: null, section_id: null }]);
  });
});

describe("folder nesting (one level)", () => {
  const TOP = fid(1, 710);
  const CHILD = fid(1, 711);
  const OTHER = fid(1, 712);

  beforeAll(async () => {
    await ownerRows(
      `insert into folders (id, owner_id, name) values ('${TOP}', '${USER_A}', 'Atas'), ('${OTHER}', '${USER_A}', 'Lain')`,
    );
    await ownerRows(
      `insert into folders (id, owner_id, name, parent_id) values ('${CHILD}', '${USER_A}', 'Anak', '${TOP}')`,
    );
  });

  it.each([
    [
      "a folder inside a child folder",
      `insert into folders (owner_id, name, parent_id) values ('${USER_A}', 'Cucu', '${CHILD}')`,
    ],
    [
      "moving a folder that has children under another folder",
      `update folders set parent_id = '${OTHER}' where id = '${TOP}'`,
    ],
    [
      "moving a folder under a child folder",
      `update folders set parent_id = '${CHILD}' where id = '${OTHER}'`,
    ],
  ])("rejects %s", async (_label, statement) => {
    expect(await sqlstateOf(() => ownerRows(statement))).toBe("23514");
    expect(await failureOf(() => ownerRows(statement))).toMatch(/folders_one_level/);
    // The same rule holds for a teacher.
    expect(await failureOf(asTeacher(statement))).toMatch(/folders_one_level/);
  });

  it("rejects a folder that is its own parent", async () => {
    expect(
      await failureOf(() =>
        ownerRows(`update folders set parent_id = id where id = '${OTHER}'`),
      ),
    ).toMatch(/folders_not_own_parent_check/);
  });

  it("counts a trashed subfolder, which the teacher's update policy hides", async () => {
    await ownerRows(`update folders set deleted_at = now() where id = '${CHILD}'`);
    try {
      expect(
        await failureOf(
          asTeacher(`update folders set parent_id = '${CHILD}' where id = '${OTHER}'`),
        ),
      ).toMatch(/folders_one_level/);
    } finally {
      await ownerRows(`update folders set deleted_at = null where id = '${CHILD}'`);
    }
  });

  it("allows moving a child back to the top level and nesting a childless folder", async () => {
    await ownerRows(`update folders set parent_id = '${TOP}' where id = '${OTHER}'`);
    await ownerRows(`update folders set parent_id = null where id = '${OTHER}'`);
    expect(
      await ownerRows(`select id from folders where parent_id = '${TOP}' order by id`),
    ).toEqual([{ id: CHILD }]);
  });
});

describe("ocr_usage", () => {
  it("keeps one row per owner and day", async () => {
    const insert = (owner: string, day: string) =>
      ownerRows(
        `insert into ocr_usage (owner_id, day, pages) values ('${owner}', '${day}', 1)`,
      );
    expect(await sqlstateOf(() => insert(USER_A, "2026-11-20"))).toBe("23505");
    expect(await failureOf(() => insert(USER_A, "2026-11-20"))).toMatch(
      /ocr_usage_owner_day_unique/,
    );
    await insert(USER_A, "2026-11-21");
    await insert(USER_B, "2026-11-21");
  });

  it("refuses a negative page count", async () => {
    expect(
      await failureOf(() =>
        ownerRows(`update ocr_usage set pages = -1 where id = '${FIXTURE.ocrUsage(1)}'`),
      ),
    ).toMatch(/ocr_usage_pages_check/);
  });
});

describe("check constraints", () => {
  it.each([
    ["materials", FIXTURE.material(1), "kind", "'doc'", "materials_kind_check"],
    ["materials", FIXTURE.material(1), "status", "'done'", "materials_status_check"],
    ["materials", FIXTURE.material(1), "grade", "10", "materials_grade_check"],
    [
      "materials",
      FIXTURE.material(1),
      "academic_year",
      "'2026'",
      "materials_academic_year_check",
    ],
    ["materials", FIXTURE.material(1), "sha256", "'abc'", "materials_sha256_check"],
    [
      "material_pages",
      FIXTURE.materialPage(1),
      "text_source",
      "'scan'",
      "material_pages_text_source_check",
    ],
    [
      "material_pages",
      FIXTURE.materialPage(1),
      "confidence",
      "'certain'",
      "material_pages_confidence_check",
    ],
    [
      "material_pages",
      FIXTURE.materialPage(1),
      "ocr_status",
      "'running'",
      "material_pages_ocr_status_check",
    ],
    [
      "material_pages",
      FIXTURE.materialPage(1),
      "flags",
      `'{"a": 1}'`,
      "material_pages_flags_check",
    ],
    [
      "material_sections",
      FIXTURE.materialSection(1),
      "page_end",
      "0",
      "material_sections_pages_check",
    ],
    [
      "solver_sessions",
      FIXTURE.solverSession(1),
      "input_kind",
      "'video'",
      "solver_sessions_input_kind_check",
    ],
    [
      "solver_sessions",
      FIXTURE.solverSession(1),
      "input_text",
      "null",
      "solver_sessions_text_input_check",
    ],
    [
      "solver_solutions",
      FIXTURE.solverSolution(1),
      "verification_status",
      "'ok'",
      "solver_solutions_verification_status_check",
    ],
    ["folders", FIXTURE.folder(1), "name", "' '", "folders_name_check"],
    ["materials", FIXTURE.material(1), "title", "''", "materials_title_check"],
    [
      "material_sections",
      FIXTURE.materialSection(1),
      "title",
      "'  '",
      "material_sections_title_check",
    ],
    [
      "solver_solutions",
      FIXTURE.solverSolution(1),
      "method_label",
      "''",
      "solver_solutions_method_label_check",
    ],
  ])("%s rejects %s = %s", async (table, id, column, value, constraint) => {
    expect(
      await failureOf(() =>
        ownerRows(`update "${table}" set "${column}" = ${value} where id = '${id}'`),
      ),
    ).toMatch(new RegExp(constraint));
  });
});

describe("question_sources citing a material", () => {
  it("requires an anchor label and an excerpt on material rows", async () => {
    for (const [columns, values] of [
      ["anchor_label", "'hal. 1'"],
      ["excerpt", "'Pola bilangan'"],
    ]) {
      expect(
        await failureOf(() =>
          ownerRows(
            `insert into question_sources (owner_id, question_version_id, kind, material_id, ${columns})
             values ('${USER_A}', '${FIXTURE.version(1)}', 'material', '${FIXTURE.material(1)}', ${values})`,
          ),
        ),
      ).toMatch(/question_sources_material_anchor_check/);
    }
  });

  it("keeps material columns off curriculum rows", async () => {
    expect(
      await failureOf(() =>
        ownerRows(
          `update question_sources set material_id = '${FIXTURE.material(1)}' where id = '${FIXTURE.source(1)}'`,
        ),
      ),
    ).toMatch(/question_sources_curriculum_no_material_check/);
  });

  it(
    "keeps the citation and the question when the material is deleted for good (MAT-11)",
    async () => {
      const fresh = await createTestDatabase();
      try {
        await seedFixtures(fresh.db);
        const source = fid(1, 720);
        const run = (statement: string) => fresh.db.execute(sql.raw(statement));
        await run(
          `insert into question_sources (id, owner_id, question_version_id, kind, material_id, material_page_id, section_id, anchor_label, excerpt)
           values ('${source}', '${USER_A}', '${FIXTURE.version(1)}', 'material', '${FIXTURE.material(1)}', '${FIXTURE.materialPage(1)}', '${FIXTURE.materialSection(1)}', 'hal. 1', 'Pola bilangan ganjil')`,
        );
        await run(`delete from materials where id = '${FIXTURE.material(1)}'`);
        expect(
          (
            await run(
              `select owner_id, kind, material_id, material_page_id, section_id, anchor_label, excerpt
               from question_sources where id = '${source}'`,
            )
          ).rows,
        ).toEqual([
          {
            owner_id: USER_A,
            kind: "material",
            material_id: null,
            material_page_id: null,
            section_id: null,
            anchor_label: "hal. 1",
            excerpt: "Pola bilangan ganjil",
          },
        ]);
        expect(
          (await run(`select id from questions where id = '${FIXTURE.question(1)}'`))
            .rows,
        ).toEqual([{ id: FIXTURE.question(1) }]);
        // The pages and sections went with the material; B's material is untouched.
        expect(
          (
            await run(
              `select (select count(*)::int from material_pages where material_id = '${FIXTURE.material(1)}') as pages,
                      (select count(*)::int from material_sections where material_id = '${FIXTURE.material(1)}') as sections,
                      (select count(*)::int from materials where id = '${FIXTURE.material(2)}') as other`,
            )
          ).rows,
        ).toEqual([{ pages: 0, sections: 0, other: 1 }]);
        // Once the material is gone, the purge may clear the stored excerpt too (decision 3).
        await run(`update question_sources set excerpt = null where id = '${source}'`);
      } finally {
        await fresh.client.close();
      }
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "moves a material to the top level when its folder is deleted for good",
    async () => {
      const fresh = await createTestDatabase();
      try {
        await seedFixtures(fresh.db);
        const run = (statement: string) => fresh.db.execute(sql.raw(statement));
        await run(`delete from folders where id = '${FIXTURE.folder(1)}'`);
        expect(
          (
            await run(
              `select owner_id, folder_id from materials where id = '${FIXTURE.material(1)}'`,
            )
          ).rows,
        ).toEqual([{ owner_id: USER_A, folder_id: null }]);
      } finally {
        await fresh.client.close();
      }
    },
    DB_TEST_TIMEOUT,
  );
});

describe("indexes", () => {
  it("creates the listing, trash, recent-session and photo-purge indexes", async () => {
    const result = await ownerRows(
      `select indexname, indexdef from pg_indexes
       where tablename in ('folders', 'materials', 'material_sections', 'solver_sessions', 'solver_solutions')
       order by indexname`,
    );
    const defs: Record<string, string> = Object.fromEntries(
      result.map((r) => [String(r.indexname), String(r.indexdef)]),
    );
    expect(defs.folders_owner_parent_idx).toMatch(/\(owner_id, parent_id\)/);
    expect(defs.folders_owner_deleted_idx).toMatch(/\(owner_id, deleted_at\)/);
    expect(defs.materials_owner_deleted_idx).toMatch(/\(owner_id, deleted_at\)/);
    expect(defs.materials_owner_folder_idx).toMatch(/\(owner_id, folder_id\)/);
    expect(defs.material_sections_material_idx).toMatch(/\(material_id\)/);
    expect(defs.solver_sessions_owner_recent_idx).toMatch(
      /\(owner_id, deleted_at, created_at DESC( NULLS LAST)?\)/,
    );
    expect(defs.solver_sessions_photo_purge_idx).toMatch(
      /\(created_at\) WHERE \(input_key IS NOT NULL\)/,
    );
    expect(defs.solver_solutions_session_idx).toMatch(/\(session_id\)/);
  });
});
