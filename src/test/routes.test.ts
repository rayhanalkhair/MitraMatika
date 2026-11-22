import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { decideProxy } from "@/features/auth";

// Route paths are English (decision D-038). This guard fails when a source file still uses one of
// the old Indonesian paths as a route literal: a string that starts with `/` followed by the old
// segment, or the same inside a regular expression (`\/masuk`). Screen text, message keys, feature
// folder names and curriculum data (none of which start with `/`) are not route literals.
const OLD_TO_NEW: Readonly<Record<string, string>> = {
  masuk: "sign-in",
  beranda: "home",
  "buat-soal": "generate",
  "bank-soal": "question-bank",
  selesaikan: "solve",
  materi: "materials",
  "penyusun-asesmen": "assessment-builder",
  sampah: "trash",
  pengaturan: "settings",
  lainnya: "more",
};

const BACKSLASH = String.fromCharCode(92);
const OLD_ROUTE = new RegExp(
  `(?:^|[^A-Za-z0-9_@.${BACKSLASH}-]|(?<=:[0-9]+))(?:${BACKSLASH}${BACKSLASH})?/(${Object.keys(OLD_TO_NEW).join("|")})(?![A-Za-z0-9_${BACKSLASH}-])`,
  "g",
);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "node_modules" && name !== ".next") walk(full, out);
    } else if (/\.(?:ts|tsx|mts)$/.test(name)) out.push(full);
  }
  return out;
}

export function findOldRoutes(source: string): string[] {
  return [...source.matchAll(OLD_ROUTE)].map((match) => match[1]);
}

describe("old Indonesian route paths", () => {
  it("are gone from src, tests and scripts", () => {
    const self = join("src", "test", "routes.test.ts");
    const hits: string[] = [];
    for (const root of ["src", "tests", "scripts"]) {
      for (const file of walk(join(process.cwd(), root))) {
        const path = relative(process.cwd(), file);
        if (path === self) continue;
        for (const old of findOldRoutes(readFileSync(file, "utf8"))) {
          hits.push(`${path}: /${old} (now /${OLD_TO_NEW[old]})`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  describe("findOldRoutes (the checker itself)", () => {
    it.each([
      ['href="/masuk"', ["masuk"]],
      ["redirect(`/bank-soal/${id}`)", ["bank-soal"]],
      ["new URL('/beranda', base)", ["beranda"]],
      ["toHaveURL(/" + BACKSLASH + "/masuk$/)", ["masuk"]],
      ['"http://localhost:3000/pengaturan"', ["pengaturan"]],
    ])("finds %s", (source, expected) => {
      expect(findOldRoutes(source)).toEqual(expected);
    });

    it.each([
      'href="/sign-in"',
      'import x from "@/features/beranda/ui/QuickAction"',
      'const key = "nav.beranda"',
      'label: "Bank Soal"',
      'href="/materials"',
      'stableKey: "topik-satu"',
    ])("ignores %s", (source) => {
      expect(findOldRoutes(source)).toEqual([]);
    });
  });
});

// Every page under (shell) as a URL path; a dynamic segment gets a sample value.
function shellRoutes(): string[] {
  const shell = join(process.cwd(), "src", "app", "(shell)");
  return walk(shell)
    .filter((file) => /[\\/]page\.tsx$/.test(file))
    .map((file) => {
      const dir = relative(shell, file).split(/[\\/]/).slice(0, -1);
      const segments = dir
        .filter((segment) => !/^\(.*\)$/.test(segment))
        .map((segment) => (/^\[.*\]$/.test(segment) ? "sample" : segment));
      return `/${segments.join("/")}`;
    });
}

describe("public and protected routes", () => {
  const anonymous = { status: "anonymous" } as const;

  it.each([
    "/sign-in",
    "/sign-up",
    "/verify-email",
    "/forgot-password",
    "/reset-password",
    "/privacy",
  ])("%s is public", (route) => {
    expect(decideProxy(route, anonymous)).toEqual({ action: "next" });
  });

  it("/waiting-approval is not public: it needs a session cookie", () => {
    expect(decideProxy("/waiting-approval", anonymous)).toEqual({
      action: "redirect",
      to: "/sign-in",
    });
  });

  it("every (shell) route still redirects anonymous users", () => {
    const routes = shellRoutes();
    expect(routes).toEqual(expect.arrayContaining(["/home", "/generate", "/settings"]));
    for (const route of [...routes, "/"]) {
      expect(decideProxy(route, anonymous), route).toEqual({
        action: "redirect",
        to: "/sign-in",
      });
    }
  });
});
