import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({
  checkDbConnection: vi.fn(),
}));

vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  requireDatabaseUrl: vi.fn(() => "postgresql://fake"),
}));

import { checkDbConnection } from "@/lib/db/client";
import { requireDatabaseUrl } from "@/lib/env";
import { GET } from "./route";
import { logger } from "@/lib/logger";

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 and status ok when the database is reachable", async () => {
    vi.mocked(checkDbConnection).mockResolvedValueOnce({
      ok: true,
      data: { latencyMs: 5 },
    });

    const response = await GET();

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.database).toBe("connected");
    expect(typeof body.timestamp).toBe("string");
  });

  it("returns 503 and status degraded when the database is unreachable", async () => {
    vi.mocked(checkDbConnection).mockResolvedValueOnce({
      ok: false,
      error: "connection refused",
    });

    const response = await GET();

    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("degraded");
    expect(body.database).toBe("error");

    // The response body must never leak the underlying error text — this is
    // a public, unauthenticated endpoint.
    expect(JSON.stringify(body)).not.toContain("connection refused");
  });

  it("returns 503 when the DATABASE_URL environment variable is missing, without calling checkDbConnection", async () => {
    vi.mocked(requireDatabaseUrl).mockImplementationOnce(() => {
      throw new Error("DATABASE_URL tidak ditemukan.");
    });

    const response = await GET();

    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("degraded");
    expect(body.database).toBe("error");
    expect(checkDbConnection).not.toHaveBeenCalled();
  });
});
