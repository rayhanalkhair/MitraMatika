import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_IP_HEADER } from "@/features/auth";
import { createTestDatabase, DB_TEST_TIMEOUT } from "@/lib/db/test-harness";
import { logger } from "@/lib/logger";

const mocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  // The real createAuth, taken from the original module inside the mock factory below.
  createAuth:
    undefined as unknown as typeof import("@/features/auth/service/auth-server").createAuth,
}));
vi.mock("@/features/auth/service/auth-server", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/features/auth/service/auth-server")>();
  mocks.createAuth = original.createAuth;
  return { ...original, getAuth: mocks.getAuth };
});

import { GET, POST } from "./route";

const request = (method: string) =>
  new Request("http://localhost:3000/api/auth/get-session", { method });

beforeEach(() => {
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  mocks.getAuth.mockReset();
});

describe("/api/auth/[...all]", () => {
  it("does not build Better Auth when the module is imported", () => {
    expect(mocks.getAuth).not.toHaveBeenCalled();
  });

  it("hands GET and POST to the Better Auth handler, built on first use", async () => {
    const handler = vi.fn((req: Request) =>
      Promise.resolve(Response.json({ method: req.method })),
    );
    mocks.getAuth.mockReturnValue({ handler });

    expect(await (await GET(request("GET"))).json()).toEqual({ method: "GET" });
    expect(await (await POST(request("POST"))).json()).toEqual({ method: "POST" });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("overwrites a client supplied client IP header before the handler sees it", async () => {
    vi.stubEnv("VERCEL", "1");
    const seen: (string | null)[] = [];
    mocks.getAuth.mockReturnValue({
      handler: (req: Request) => {
        seen.push(req.headers.get(CLIENT_IP_HEADER));
        return Promise.resolve(Response.json({}));
      },
    });
    const post = (headers: Record<string, string>) =>
      POST(
        new Request("http://localhost:3000/api/auth/sign-in/social", {
          method: "POST",
          headers,
          body: "{}",
        }),
      );
    await post({
      [CLIENT_IP_HEADER]: "6.6.6.6",
      "x-vercel-forwarded-for": "203.0.113.5",
    });
    await post({ [CLIENT_IP_HEADER]: "6.6.6.6", "x-forwarded-for": "7.7.7.7" });
    vi.unstubAllEnvs();
    expect(seen).toEqual(["203.0.113.5", null]);
  });

  it("answers 503 auth_unavailable when the configuration is missing", async () => {
    mocks.getAuth.mockImplementation(() => {
      throw new Error("BETTER_AUTH_SECRET tidak ditemukan");
    });
    for (const call of [GET, POST]) {
      const response = await call(request("GET"));
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: "auth_unavailable" });
    }
    expect(logger.error).toHaveBeenCalled();
  });
});

// The real Better Auth (PGlite, a fake Google client) behind the route, called with the request
// classes Next can hand to a handler. A crash in the route's own request handling (as happened on
// Vercel: "Failed to parse URL from [object Request]") shows up here as a thrown error or a 500.
describe("/api/auth/[...all] with the real Better Auth", () => {
  const ORIGIN = "http://localhost:3000";
  const social = (Class: typeof Request | typeof NextRequest) =>
    new Class(`${ORIGIN}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ provider: "google", callbackURL: "/auth/callback" }),
    });

  async function useRealAuth() {
    const t = await createTestDatabase();
    mocks.getAuth.mockReturnValue(
      mocks.createAuth({
        db: t.db,
        secret: "route-test-secret-".padEnd(40, "x"),
        baseURL: ORIGIN,
        google: { clientId: "dummy-client-id", clientSecret: "dummy-client-secret" },
        runInBackground: () => undefined,
      }),
    );
  }

  it.each([
    ["a global Request", Request],
    ["a NextRequest", NextRequest],
  ])(
    "answers POST /sign-in/social with a Google URL for %s",
    async (_name, Class) => {
      await useRealAuth();
      const response = await POST(social(Class));
      expect(response.status).toBe(200);
      const body = (await response.json()) as { url?: string; redirect?: boolean };
      expect(body.url?.startsWith("https://accounts.google.com/")).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it.each([
    ["a global Request", Request],
    ["a NextRequest", NextRequest],
  ])(
    "answers GET /ok for %s",
    async (_name, Class) => {
      await useRealAuth();
      const response = await GET(new Class(`${ORIGIN}/api/auth/ok`));
      expect(response.status).toBe(200);
    },
    DB_TEST_TIMEOUT,
  );
});
