import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./schema";
import { authenticatedRole } from "./tables/roles";

const tables = Object.values(schema as Record<string, unknown>).filter(
  (value): value is PgTable => is(value, PgTable),
);
const config = (name: string) => {
  const table = tables.find((t) => getTableConfig(t).name === name);
  if (!table) throw new Error(`table ${name} is not exported from schema.ts`);
  return getTableConfig(table);
};

const CURRICULUM = [
  "curriculum_versions",
  "cp_elements",
  "topics",
  "learning_objectives",
];
const OWNER_TABLES = [
  "profiles",
  "generation_requests",
  "generation_runs",
  "questions",
  "question_versions",
  "question_sources",
  "verification_runs",
  "jobs",
  "ai_calls",
  "audit_log",
  "usage_events",
  "deletion_log",
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
];
const AUTH_TABLES = ["user", "session", "account", "verification", "rate_limit"];

describe("slice schema", () => {
  it("exports exactly the app tables", () => {
    expect(tables.map((t) => getTableConfig(t).name).sort()).toEqual(
      [...CURRICULUM, ...OWNER_TABLES, "app_errors", "job_runs", ...AUTH_TABLES].sort(),
    );
  });

  it("enables row level security on every table", () => {
    for (const table of tables) {
      const c = getTableConfig(table);
      expect(c.enableRLS, `${c.name} must have RLS enabled`).toBe(true);
    }
  });

  it("gives every owner table a NOT NULL owner_id and curriculum tables none", () => {
    // audit_log and deletion_log are the exceptions: their rows outlive the account (owner set null).
    for (const name of OWNER_TABLES.filter(
      (n) => n !== "profiles" && n !== "audit_log" && n !== "deletion_log",
    )) {
      const owner = config(name).columns.find((c) => c.name === "owner_id");
      expect(owner, `${name} needs owner_id`).toBeDefined();
      expect(owner?.notNull, `${name}.owner_id must be NOT NULL`).toBe(true);
    }
    for (const name of CURRICULUM) {
      expect(config(name).columns.some((c) => c.name === "owner_id")).toBe(false);
    }
  });

  it("keeps app_errors.owner_id, job_runs.owner_id and audit_log.owner_id nullable", () => {
    for (const name of ["app_errors", "job_runs", "audit_log"]) {
      const owner = config(name).columns.find((c) => c.name === "owner_id");
      expect(owner?.notNull, name).toBe(false);
    }
  });

  it("gives job_runs a job_id that cascades from jobs", () => {
    const fk = config("job_runs").foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === "job_id"),
    );
    expect(fk?.onDelete).toBe("cascade");
    expect(getTableConfig(fk!.reference().foreignTable).name).toBe("jobs");
  });

  it("declares owner-select RLS on job_runs for the authenticated role", () => {
    const policies = config("job_runs").policies;
    expect(policies.map((p) => [p.name, p.for])).toEqual([
      ["job_runs_owner_select", "select"],
    ]);
  });

  it("gives questions the trash and search columns and their indexes", () => {
    const c = config("questions");
    const column = (name: string) => c.columns.find((col) => col.name === name);
    expect(column("deleted_at")?.notNull).toBe(false);
    expect(column("purge_after")?.notNull).toBe(false);
    expect(column("search_text")?.notNull).toBe(true);
    expect(c.indexes.map((i) => i.config.name).sort()).toEqual([
      "questions_owner_deleted_banked_idx",
      "questions_search_trgm",
    ]);
  });

  it("gives deletion_log an owner select policy only", () => {
    expect(config("deletion_log").policies.map((p) => [p.name, p.for])).toEqual([
      ["deletion_log_owner_select", "select"],
    ]);
  });

  it("gives every policy the app-owned authenticated role", () => {
    for (const table of tables) {
      for (const policy of getTableConfig(table).policies) {
        expect(policy.to, policy.name).toBe(authenticatedRole);
      }
    }
  });

  it("declares unique (id, owner_id) on every table another owner table references", () => {
    for (const name of [
      "generation_requests",
      "generation_runs",
      "jobs",
      "questions",
      "question_versions",
      "school_templates",
      "assessments",
      "exports",
      "folders",
      "materials",
      "material_pages",
      "material_sections",
      "solver_sessions",
    ]) {
      const hasPair = config(name).uniqueConstraints.some(
        (u) => u.columns.map((c) => c.name).join(",") === "id,owner_id",
      );
      expect(hasPair, `${name} needs unique (id, owner_id)`).toBe(true);
    }
  });

  it("references other owner tables only through composite (x_id, owner_id) foreign keys", () => {
    const expected: [string, string, string][] = [
      ["generation_requests", "job_id", "jobs"],
      ["generation_runs", "request_id", "generation_requests"],
      ["questions", "generation_request_id", "generation_requests"],
      ["question_versions", "question_id", "questions"],
      ["question_versions", "generation_run_id", "generation_runs"],
      ["question_sources", "question_version_id", "question_versions"],
      ["verification_runs", "question_version_id", "question_versions"],
      ["ai_calls", "job_id", "jobs"],
      ["assessments", "template_id", "school_templates"],
      ["assessment_sections", "assessment_id", "assessments"],
      ["assessment_items", "assessment_id", "assessments"],
      ["assessment_items", "question_id", "questions"],
      ["exports", "assessment_id", "assessments"],
      ["exports", "job_id", "jobs"],
      ["question_usages", "assessment_id", "assessments"],
      ["question_usages", "question_id", "questions"],
      ["folders", "parent_id", "folders"],
      ["material_sections", "material_id", "materials"],
      ["material_pages", "material_id", "materials"],
      ["solver_solutions", "session_id", "solver_sessions"],
      ["solver_solutions", "generation_run_id", "generation_runs"],
    ];
    for (const [child, column, parent] of expected) {
      const found = config(child).foreignKeys.some((fk) => {
        const ref = fk.reference();
        return (
          ref.columns.map((c) => c.name).join(",") === `${column},owner_id` &&
          getTableConfig(ref.foreignTable).name === parent
        );
      });
      expect(
        found,
        `${child}.${column} -> ${parent} must be composite with owner_id`,
      ).toBe(true);
    }
  });

  it("does not declare the circular question/version foreign keys (the custom migration owns them)", () => {
    const columns = config("questions").foreignKeys.flatMap((fk) =>
      fk.reference().columns.map((c) => c.name),
    );
    expect(columns).not.toContain("current_version_id");
    expect(columns).not.toContain("approved_version_id");
  });
});

describe("assessment schema", () => {
  const fk = (table: string, columns: string) => {
    const found = config(table).foreignKeys.find(
      (f) =>
        f
          .reference()
          .columns.map((c) => c.name)
          .join(",") === columns,
    );
    if (!found) throw new Error(`${table} has no foreign key on ${columns}`);
    return found;
  };

  it("gives the teacher-written tables owner select, insert, update and delete policies", () => {
    for (const name of [
      "school_templates",
      "assessments",
      "assessment_sections",
      "assessment_items",
    ]) {
      expect(
        config(name)
          .policies.map((p) => p.for)
          .sort(),
        name,
      ).toEqual(["delete", "insert", "select", "update"]);
    }
  });

  it("gives exports and question_usages an owner select policy only (the export job writes them)", () => {
    for (const name of ["exports", "question_usages"]) {
      expect(config(name).policies.map((p) => [p.name, p.for])).toEqual([
        [`${name}_owner_select`, "select"],
      ]);
    }
  });

  it("pins an item's version to its question and owner without cascading (Ruling R2)", () => {
    const pin = fk("assessment_items", "question_version_id,question_id,owner_id");
    expect(getTableConfig(pin.reference().foreignTable).name).toBe("question_versions");
    expect(pin.onDelete ?? "no action").toBe("no action");
    expect(fk("assessment_items", "question_id,owner_id").onDelete ?? "no action").toBe(
      "no action",
    );
  });

  it("deletes sections, items, exports and usages with their assessment", () => {
    expect(fk("assessment_sections", "assessment_id,owner_id").onDelete).toBe("cascade");
    expect(fk("assessment_items", "assessment_id,owner_id").onDelete).toBe("cascade");
    expect(fk("assessment_items", "section_id,assessment_id,owner_id").onDelete).toBe(
      "cascade",
    );
    expect(fk("exports", "assessment_id,owner_id").onDelete).toBe("cascade");
    expect(fk("question_usages", "assessment_id,owner_id").onDelete).toBe("cascade");
  });

  it("stores points as numeric(6,2) and the shuffle seed as a nullable integer", () => {
    const column = (table: string, name: string) =>
      config(table).columns.find((c) => c.name === name);
    expect(column("assessment_items", "points")?.getSQLType()).toBe("numeric(6, 2)");
    expect(column("assessments", "shuffle_seed")?.getSQLType()).toBe("integer");
    expect(column("assessments", "shuffle_seed")?.notNull).toBe(false);
    for (const table of ["school_templates", "assessments"]) {
      expect(column(table, "row_version")?.notNull, table).toBe(true);
      expect(column(table, "deleted_at")?.notNull, table).toBe(false);
      expect(column(table, "purge_after")?.notNull, table).toBe(false);
    }
  });
});

describe("profiles schema", () => {
  it("has the expected columns", () => {
    expect(config("profiles").columns.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "id",
        "display_name",
        "school_name",
        "locale",
        "timezone",
        "created_at",
        "updated_at",
      ]),
    );
  });

  it("references user on delete cascade", () => {
    const [fk] = config("profiles").foreignKeys;
    const ref = fk.reference();
    expect(ref.columns.map((c) => c.name)).toEqual(["id"]);
    expect(getTableConfig(ref.foreignTable).name).toBe("user");
    expect(getTableConfig(ref.foreignTable).schema).toBeUndefined();
    expect(fk.onDelete).toBe("cascade");
  });
});

describe("Better Auth schema", () => {
  it("uses uuid primary keys with a database default on every auth table", () => {
    for (const name of AUTH_TABLES) {
      const id = config(name).columns.find((c) => c.name === "id");
      expect(id?.getSQLType(), name).toBe("uuid");
      expect(id?.primary, name).toBe(true);
      expect(id?.hasDefault, name).toBe(true);
    }
  });

  it("has the column names Better Auth expects", () => {
    const names = (table: string) =>
      config(table)
        .columns.map((c) => c.name)
        .sort();
    expect(names("user")).toEqual(
      [
        "id",
        "name",
        "email",
        "email_verified",
        "image",
        "created_at",
        "updated_at",
      ].sort(),
    );
    expect(names("session")).toEqual(
      [
        "id",
        "expires_at",
        "token",
        "created_at",
        "updated_at",
        "ip_address",
        "user_agent",
        "user_id",
      ].sort(),
    );
    expect(names("account")).toEqual(
      [
        "id",
        "account_id",
        "provider_id",
        "user_id",
        "access_token",
        "refresh_token",
        "id_token",
        "access_token_expires_at",
        "refresh_token_expires_at",
        "scope",
        "password",
        "created_at",
        "updated_at",
      ].sort(),
    );
    expect(names("verification")).toEqual(
      ["id", "identifier", "value", "expires_at", "created_at", "updated_at"].sort(),
    );
    expect(names("rate_limit")).toEqual(["id", "key", "count", "last_request"].sort());
  });

  it("stores rate-limit keys uniquely and the last request as epoch milliseconds", () => {
    const columns = config("rate_limit").columns;
    const column = (name: string) => columns.find((c) => c.name === name);
    expect(column("key")?.isUnique).toBe(true);
    expect(column("key")?.notNull).toBe(true);
    expect(column("count")?.getSQLType()).toBe("integer");
    expect(column("count")?.notNull).toBe(true);
    expect(column("last_request")?.getSQLType()).toBe("bigint");
    expect(column("last_request")?.notNull).toBe(true);
  });
});
