import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A pending account (signed in, email not approved) that posts a Server Action or calls an API
// route directly gets "unauthenticated" or 401, and nothing is written (ADR-0022, review focus).
// Every guarded entry point found by walking the tree is called with the real guard, a session
// for an unlisted address and a database that fails the test on any use.

const mocks = vi.hoisted(() => ({
  dbCalls: [] as string[],
  getAuthPort: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
  notFound: (): never => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined }),
  headers: () => Promise.resolve(new Headers()),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/features/auth/service/port-server", () => ({
  getAuthPort: mocks.getAuthPort,
}));
// Handing out the connection handle is not a database call (some routes build their deps eagerly);
// any method called on it is, and fails the test.
vi.mock("@/lib/db/runtime", () => ({
  getDb: () =>
    new Proxy(
      {},
      {
        get: (_target, property) =>
          typeof property === "symbol"
            ? undefined
            : () => {
                mocks.dbCalls.push(`getDb().${property}`);
                throw new Error("database used by a pending account");
              },
      },
    ),
  resetDbForTests: vi.fn(),
}));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  runAsUser: () => {
    mocks.dbCalls.push("runAsUser");
    throw new Error("database used by a pending account");
  },
}));

import { createFakeAuthPort } from "@/features/auth";

// Guarded means: the body uses the approved guard (not the signed-in one, which pending passes).
const GUARD = /\b(?:requireAllowedUser|authorizeAction)\b/;
const HTTP = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g;
const ACTION = /export\s+(?:async\s+function\s+(\w+)|const\s+(\w+)\s*=\s*async)/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

function chunks(source: string, pattern: RegExp): { name: string; body: string }[] {
  const starts = [...source.matchAll(pattern)].map((m) => ({
    name: m[1] || m[2],
    index: m.index,
  }));
  return starts.map((s, i) => ({
    name: s.name,
    body: source.slice(s.index, starts[i + 1]?.index ?? source.length),
  }));
}

interface Target {
  key: string;
  file: string;
  name: string;
  kind: "action" | "route";
}

function findTargets(): Target[] {
  const targets: Target[] = [];
  for (const full of walk(join(process.cwd(), "src"))) {
    const path = relative(process.cwd(), full).split("\\").join("/");
    const source = readFileSync(full, "utf8");
    if (/^src\/app\/.*\/route\.ts$/.test(path)) {
      for (const c of chunks(source, HTTP)) {
        if (GUARD.test(c.body)) {
          targets.push({
            key: `${path}#${c.name}`,
            file: full,
            name: c.name,
            kind: "route",
          });
        }
      }
    } else if (/^\s*(?:\/\/.*\n|\/\*[\s\S]*?\*\/\s*)*["']use server["']/.test(source)) {
      for (const c of chunks(source, ACTION)) {
        if (GUARD.test(c.body)) {
          targets.push({
            key: `${path}#${c.name}`,
            file: full,
            name: c.name,
            kind: "action",
          });
        }
      }
    }
  }
  return targets;
}

const TARGETS = findTargets();

beforeEach(() => {
  mocks.dbCalls.length = 0;
  vi.stubEnv("ADMIN_EMAIL", "boss@example.test");
  mocks.getAuthPort.mockResolvedValue(
    createFakeAuthPort({
      getSessionUser: { user: { id: "user-9", email: "pending@example.test" } },
    }),
  );
});

describe("pending account against every guarded entry point", () => {
  it("finds the guarded Server Actions and route handlers", () => {
    expect(TARGETS.filter((t) => t.kind === "route").length).toBeGreaterThanOrEqual(7);
    expect(TARGETS.filter((t) => t.kind === "action").length).toBeGreaterThanOrEqual(30);
  });

  it.each(TARGETS.map((t) => [t.key, t] as const))(
    "%s refuses a pending account and writes nothing",
    async (_key, target) => {
      const loaded = (await import(/* @vite-ignore */ target.file)) as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      const handler = loaded[target.name];
      if (target.kind === "route") {
        const response = (await handler(
          new Request("http://localhost/api/x", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
          { params: Promise.resolve({ id: "x", requestId: "x" }) },
        )) as Response;
        expect(response.status).toBe(401);
      } else {
        const result = await handler({}, new FormData(), {});
        expect(JSON.stringify(result ?? null)).not.toMatch(/"ok":true/);
      }
      expect(mocks.dbCalls).toEqual([]);
    },
    60_000,
  );
});
