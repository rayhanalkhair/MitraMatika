import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Sign-up is open: the private allowlist is gone for good. No source, test, script, workflow or
// env template may bring it back by name. This file is the one place allowed to say the names.
const ROOT = process.cwd();
const SELF = relative(ROOT, fileURLToPath(import.meta.url)).replaceAll("\\", "/");
const FORBIDDEN = /getAllowedEmails|ALLOWED_EMAILS/;
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
];

describe("the allowlist is gone", () => {
  it("scans a non-trivial set of files", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("no source file mentions getAllowedEmails or ALLOWED_EMAILS", () => {
    const offenders = files
      .map((file) => relative(ROOT, file).replaceAll("\\", "/"))
      .filter((file) => file !== SELF)
      .filter((file) => FORBIDDEN.test(readFileSync(join(ROOT, file), "utf8")));
    expect(offenders).toEqual([]);
  });
});
