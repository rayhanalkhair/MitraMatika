import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The tests import modules cold, which can pass 5 s when the whole suite runs at once, so each gets 30 s.
// Validation ON (VITEST blanked so it is not skipped) and no DATABASE_URL: nothing may throw
// at import time, the proxy must still fail closed and the health route must still answer.
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITEST", "");
  vi.stubEnv("SKIP_ENV_VALIDATION", "");
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("CRON_SECRET", "too-short");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("lazy env with validation on and DATABASE_URL unset", () => {
  it("protect() imports, does not throw and lets a fake-session user through", async () => {
    vi.stubEnv("E2E_FAKE_AUTH", "1");
    vi.stubEnv("NODE_ENV", "development");
    const { protect } = await import("@/features/auth/service/protect");
    const response = await protect(
      new NextRequest("http://localhost:3000/home", {
        headers: { cookie: "e2e-user=teacher@example.test" },
      }),
    );
    expect(response.headers.get("x-middleware-next")).toBe("1");
  }, 30_000);

  it("protect() sends an anonymous visitor to /sign-in", async () => {
    const { protect } = await import("@/features/auth/service/protect");
    const response = await protect(new NextRequest("http://localhost:3000/home"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/sign-in");
  }, 30_000);

  it("the guard imports and treats everyone as anonymous without auth configuration", async () => {
    const { loadAccess } = await import("@/features/auth/service/load-access");
    const { getAuthPort } = await import("@/features/auth/service/port-server");
    const access = await loadAccess({
      getPort: getAuthPort,
      readE2eCookie: () => Promise.resolve(undefined),
    });
    expect(access).toEqual({ status: "anonymous" });
  }, 30_000);

  it("the Better Auth route answers 503 instead of throwing", async () => {
    const { POST } = await import("@/app/api/auth/[...all]/route");
    const response = await POST(
      new Request("http://localhost:3000/api/auth/sign-in/social", { method: "POST" }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "auth_unavailable" });
  }, 30_000);

  it("the health route answers degraded instead of throwing", async () => {
    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    expect(response.status).toBe(503);
    expect(((await response.json()) as { status: string }).status).toBe("degraded");
  }, 30_000);

  it("requireGroqApiKey() works without DATABASE_URL", async () => {
    vi.stubEnv("GROQ_API_KEY", "gsk_only");
    const { requireGroqApiKey, requireDatabaseUrl } = await import("@/lib/env");
    expect(requireGroqApiKey()).toBe("gsk_only");
    expect(() => requireDatabaseUrl()).toThrow(/DATABASE_URL tidak ditemukan/);
  }, 30_000);
});
