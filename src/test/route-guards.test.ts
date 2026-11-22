import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Route inventory: every page, layout, route handler and Server Action under src must reach the
// authoritative guard (requireAllowedUser() or authorizeAction() from the auth feature), or sit
// on the explicit allowlist below with a reason. A new file with neither fails this test.

// A call, or the guard handed to a handler as a value (`authorize: authorizeAction`).
const GUARD_CALL = /\b(?:requireAllowedUser|authorizeAction)\b/;
const SHELL_DIR = "src/app/(shell)/";
const SHELL_LAYOUT = "src/app/(shell)/layout.tsx";

// Public on purpose. Keys are repo-relative paths (or `path#exportedFunction` for a Server
// Action); each carries the reason it needs no guard.
export const PUBLIC_ALLOWLIST: Readonly<Record<string, string>> = {
  "src/app/layout.tsx": "root layout: html shell, fonts and providers, no user data",
  "src/app/page.tsx": "/ only redirects to /home, which is guarded",
  "src/app/(auth)/sign-in/page.tsx": "/sign-in: the sign-in page itself, must be public",
  "src/app/(auth)/sign-up/page.tsx":
    "/sign-up: open sign-up, for people without an account",
  "src/app/(auth)/verify-email/page.tsx":
    "/verify-email: the check-your-email notice and resend, before any session exists",
  "src/app/(auth)/forgot-password/page.tsx":
    "/forgot-password: asks for a reset link, for people who cannot sign in",
  "src/app/(auth)/reset-password/page.tsx":
    "/reset-password: the reset link's page; the token is the credential",
  "src/app/privacy/page.tsx": "/privacy: the static privacy notice, linked from sign-up",
  "src/features/auth/actions/sign-in.ts#signInAction":
    "the sign-in form itself; Better Auth's per-IP limit applies through auth.handler",
  "src/features/auth/actions/sign-up.ts#signUpAction":
    "the sign-up form; the same answer for every address, rate limited through auth.handler",
  "src/features/auth/actions/verify-email.ts#resendVerificationAction":
    "resends the verification link; the same answer for every address, rate limited",
  "src/features/auth/actions/forgot-password.ts#requestPasswordResetAction":
    "requests a reset link; the same answer for every address, rate limited",
  "src/features/auth/actions/reset-password.ts#resetPasswordAction":
    "sets a new password with the emailed token, which Better Auth checks; rate limited",
  "src/app/auth/callback/route.ts":
    "/auth/callback: Google sign-in landing; reads the session itself and ensures the profile",
  "src/app/api/health/route.ts": "/api/health: liveness probe, returns no user data",
  "src/app/api/auth/[...all]/route.ts":
    "/api/auth/*: Better Auth's own handler (sign-in, OAuth callback), rate limited",
  "src/app/api/jobs/run/route.ts":
    "/api/jobs/run: called by Vercel Cron, protected by CRON_SECRET",
  "src/app/api/e2e/control/route.ts":
    "/api/e2e/control: test control, 404 unless E2E_FAKE_AI=1 (never in production)",
  "src/app/api/dev/upload/route.ts":
    "/api/dev/upload: the dev/e2e stand-in for R2's signed PUT, 404 unless the in-memory store is in use (never in production); the signed URL authorises the upload, as on R2",
  "src/features/settings/actions/set-locale.ts#setLocaleAction":
    "writes only the locale cookie, also used on the public sign-in page",
};

// Comments and import statements never count as using the guard.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/^import\b[\s\S]*?\bfrom\s+["'][^"']+["'];?/gm, "");
}

const callsGuard = (source: string) => GUARD_CALL.test(stripComments(source));

const isAppEntry = (path: string) =>
  /^src\/app\/(?:.*\/)?(?:page\.tsx|layout\.tsx|route\.ts)$/.test(path);

const isServerActionFile = (source: string) =>
  /^\s*(?:\/\/.*\n|\/\*[\s\S]*?\*\/\s*)*["']use server["']/.test(source);

const ACTION_EXPORT = /export\s+(?:async\s+function\s+(\w+)|const\s+(\w+)\s*=\s*async)/g;

function actionChunks(source: string): { name: string; body: string }[] {
  const body = stripComments(source);
  const starts = [...body.matchAll(ACTION_EXPORT)].map((match) => ({
    name: match[1] || match[2],
    index: match.index,
  }));
  return starts.map((start, i) => ({
    name: start.name,
    body: body.slice(start.index, starts[i + 1]?.index ?? body.length),
  }));
}

/** Returns one message per violation. `files` maps repo-relative path to source. */
export function checkGuards(
  files: Readonly<Record<string, string>>,
  allowlist: Readonly<Record<string, string>> = PUBLIC_ALLOWLIST,
): string[] {
  const problems: string[] = [];
  const shellGuarded = callsGuard(files[SHELL_LAYOUT] ?? "");

  for (const [path, source] of Object.entries(files)) {
    if (isAppEntry(path) && !(path in allowlist) && !callsGuard(source)) {
      // A page under (shell) inherits the shell layout's guard, unless it opts out of rendering
      // inside the layout's request-time scope by exporting `dynamic`.
      const inherits =
        shellGuarded &&
        path.startsWith(SHELL_DIR) &&
        path.endsWith("/page.tsx") &&
        !/export\s+const\s+dynamic\b/.test(stripComments(source));
      if (!inherits) problems.push(`${path}: no guard call and not on the allowlist`);
    }
    if (isServerActionFile(source)) {
      for (const action of actionChunks(source)) {
        if (!GUARD_CALL.test(action.body) && !(`${path}#${action.name}` in allowlist)) {
          problems.push(
            `${path}#${action.name}: Server Action without a guard call and not on the allowlist`,
          );
        }
      }
    }
  }

  for (const [key, reason] of Object.entries(allowlist)) {
    const [path] = key.split("#");
    if (!(path in files))
      problems.push(`${key}: allowlist entry for a file that is gone`);
    if (reason.trim() === "") problems.push(`${key}: allowlist entry without a reason`);
  }
  return problems;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(?:ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

function readTree(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const full of walk(join(process.cwd(), "src"))) {
    const path = relative(process.cwd(), full).split("\\").join("/");
    const source = readFileSync(full, "utf8");
    if (isAppEntry(path) || isServerActionFile(source)) files[path] = source;
  }
  return files;
}

describe("route guard inventory (real tree)", () => {
  it("finds the entries it is meant to check", () => {
    const files = readTree();
    const paths = Object.keys(files);
    expect(paths).toContain(SHELL_LAYOUT);
    expect(paths.filter((p) => p.endsWith("/route.ts")).length).toBeGreaterThanOrEqual(7);
    expect(paths.filter((p) => p.endsWith("/page.tsx")).length).toBeGreaterThanOrEqual(
      10,
    );
    expect(paths.filter((p) => p.includes("/actions/")).length).toBeGreaterThanOrEqual(3);
  });

  it("has every page, layout, route handler and Server Action guarded or allowlisted", () => {
    expect(checkGuards(readTree())).toEqual([]);
  });

  it("guards the shell layout directly", () => {
    expect(callsGuard(readTree()[SHELL_LAYOUT] ?? "")).toBe(true);
  });
});

describe("checkGuards (synthetic inputs)", () => {
  const SHELL = `export default async function L(){ await requireAllowedUser(); }`;
  const base = { [SHELL_LAYOUT]: SHELL };

  it("passes a guarded route handler and an allowlisted public one", () => {
    expect(
      checkGuards(
        {
          "src/app/api/a/route.ts": "const a = await authorizeAction();",
          "src/app/api/b/route.ts": "export function GET(){}",
        },
        { "src/app/api/b/route.ts": "public probe" },
      ),
    ).toEqual([]);
  });

  it("FAILS for a new route handler with no guard and no allowlist entry", () => {
    const problems = checkGuards(
      {
        "src/app/api/new/route.ts": "export function GET(){ return Response.json({}); }",
      },
      {},
    );
    expect(problems).toEqual([
      "src/app/api/new/route.ts: no guard call and not on the allowlist",
    ]);
  });

  it("FAILS for a new page outside (shell) with no guard", () => {
    expect(
      checkGuards({ "src/app/extra/page.tsx": "export default () => null" }, {}),
    ).toHaveLength(1);
  });

  it("does not count a guard name in a comment", () => {
    expect(
      checkGuards(
        {
          "src/app/api/c/route.ts":
            "// TODO call requireAllowedUser() here\n/* authorizeAction() */",
        },
        {},
      ),
    ).toHaveLength(1);
  });

  it("does not count an import of the guard", () => {
    expect(
      checkGuards(
        {
          "src/app/api/d/route.ts":
            'import { authorizeAction } from "@/features/auth";\nexport function GET(){}',
        },
        {},
      ),
    ).toHaveLength(1);
  });

  it("counts a guard handed to a handler as a value", () => {
    expect(
      checkGuards(
        {
          "src/app/api/e/route.ts":
            'import { authorizeAction } from "@/features/auth";\nconst h = { authorize: authorizeAction };',
        },
        {},
      ),
    ).toEqual([]);
  });

  it("covers a (shell) page through the guarded shell layout", () => {
    expect(
      checkGuards(
        { ...base, "src/app/(shell)/new/page.tsx": "export default () => null" },
        {},
      ),
    ).toEqual([]);
  });

  it("FAILS a (shell) page when the shell layout does not call the guard", () => {
    const problems = checkGuards(
      {
        [SHELL_LAYOUT]: "export default function L(){}",
        "src/app/(shell)/new/page.tsx": "export default () => null",
      },
      {},
    );
    expect(problems).toHaveLength(2);
  });

  it("FAILS a (shell) page that exports dynamic", () => {
    const problems = checkGuards(
      {
        ...base,
        "src/app/(shell)/new/page.tsx": 'export const dynamic = "force-static";',
      },
      {},
    );
    expect(problems).toHaveLength(1);
  });

  it("FAILS a Server Action function without a guard, even in a file where another has one", () => {
    const source = [
      '"use server";',
      "export async function safe() { await authorizeAction(); }",
      "export async function leaky() { return 1; }",
      "export const arrow = async () => 2;",
    ].join("\n");
    const problems = checkGuards({ "src/features/x/actions/a.ts": source }, {});
    expect(problems).toEqual([
      "src/features/x/actions/a.ts#leaky: Server Action without a guard call and not on the allowlist",
      "src/features/x/actions/a.ts#arrow: Server Action without a guard call and not on the allowlist",
    ]);
  });

  it("accepts an allowlisted Server Action function", () => {
    const source = '"use server";\nexport async function open() { return 1; }';
    expect(
      checkGuards(
        { "src/features/x/actions/a.ts": source },
        { "src/features/x/actions/a.ts#open": "public form" },
      ),
    ).toEqual([]);
  });

  it("flags a stale allowlist entry and an entry without a reason", () => {
    const problems = checkGuards({}, { "src/app/gone/route.ts": "" });
    expect(problems).toHaveLength(2);
  });
});

describe("job status route duration", () => {
  it("pins maxDuration to 300 seconds (the kicked runner runs in its after())", () => {
    const source = readFileSync(
      join(process.cwd(), "src/app/api/jobs/[id]/route.ts"),
      "utf8",
    );
    expect(source).toMatch(/^export const maxDuration = 300;$/m);
  });
});

describe("route durations", () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

  it.each(["src/app/api/auth/[...all]/route.ts"])(
    "pins maxDuration to 30 seconds in %s (after() is bound to it)",
    (path) => {
      expect(read(path)).toMatch(/^export const maxDuration = 30;$/m);
    },
  );
});
