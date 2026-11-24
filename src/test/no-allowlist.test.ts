import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The retired Supabase-era function name stays forbidden everywhere. The variable ALLOWED_EMAILS
// is the post-sign-up approval list (ADR-0022): sign-up is open, and only the files below may name
// it, so the rule has one reading place (approval.ts) and nothing else grows its own copy.
// This file is the one place allowed to say the retired name.
const ROOT = process.cwd();
const SELF = relative(ROOT, fileURLToPath(import.meta.url)).replaceAll("\\", "/");
const RETIRED_FUNCTION = "getAllowedEmails";
const APPROVAL_VARIABLE = "ALLOWED_EMAILS";
const ALLOWED_FILES = [
  "src/lib/env.ts",
  "src/lib/env.test.ts",
  "src/features/auth/service/approval.ts",
  "src/features/auth/service/approval.test.ts",
  "src/features/auth/service/access.test.ts",
  "src/features/auth/service/load-access.test.ts",
  ".env.example",
  "playwright.config.ts",
  // The admin spec asserts that the approval list does NOT name the admin, so it cannot pass for
  // the wrong reason; it reads the variable the server was given, like playwright.config.ts.
  "tests/e2e/admin-account.spec.ts",
  ".github/workflows/ci.yml",
];
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|yml|yaml)$/;
const SKIP = new Set([
  "node_modules",
  ".next",
  "coverage",
  "test-results",
  "playwright-report",
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return TEXT.test(name) ? [path] : [];
  });
}

const files = [
  ...walk(join(ROOT, "src")),
  ...walk(join(ROOT, "tests")),
  ...walk(join(ROOT, "scripts")),
  ...walk(join(ROOT, ".github")),
  join(ROOT, "playwright.config.ts"),
  join(ROOT, ".env.example"),
].map((file) => relative(ROOT, file).replaceAll("\\", "/"));

const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

describe("the retired allowlist function stays gone", () => {
  it("scans a non-trivial set of files", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("no source file mentions getAllowedEmails", () => {
    const offenders = files
      .filter((file) => file !== SELF)
      .filter((file) => read(file).includes(RETIRED_FUNCTION));
    expect(offenders).toEqual([]);
  });

  it("the variable name does not match the retired-function pattern", () => {
    expect(APPROVAL_VARIABLE.includes(RETIRED_FUNCTION)).toBe(false);
  });
});

describe("ALLOWED_EMAILS is named only where it is needed", () => {
  it("every listed file exists", () => {
    expect(ALLOWED_FILES.filter((file) => !existsSync(join(ROOT, file)))).toEqual([]);
  });

  it("no other file mentions it", () => {
    const offenders = files
      .filter((file) => file !== SELF)
      .filter((file) => !ALLOWED_FILES.includes(file))
      .filter((file) => read(file).includes(APPROVAL_VARIABLE));
    expect(offenders).toEqual([]);
  });

  it("the env template documents it and ADMIN_EMAIL", () => {
    const template = read(".env.example");
    expect(template).toMatch(/^ALLOWED_EMAILS=/m);
    expect(template).toMatch(/^ADMIN_EMAIL=/m);
  });

  it("the env schema and the approval code read it", () => {
    expect(read("src/lib/env.ts")).toContain(APPROVAL_VARIABLE);
    expect(read("src/features/auth/service/approval.ts")).toContain(APPROVAL_VARIABLE);
  });
});
