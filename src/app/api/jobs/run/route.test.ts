import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const RESULT = { steps: [], jobs: null, budgetMs: 200_000 };
const { afterMock, runTickMock, recordRunMock } = vi.hoisted(() => ({
  afterMock: vi.fn<(task: () => Promise<void>) => void>(),
  runTickMock: vi.fn<(input: { housekeeping: { name: string }[] }) => Promise<unknown>>(
    () => Promise.resolve({ steps: [], jobs: null, budgetMs: 200_000 }),
  ),
  recordRunMock: vi.fn<
    (db: unknown, input: { at: Date; trigger: string; result: unknown }) => Promise<void>
  >(() => Promise.resolve()),
}));
vi.mock("next/server", () => ({
  after: (task: () => Promise<void>) => {
    afterMock(task);
  },
}));
vi.mock("@/lib/jobs/tick", () => ({ runTick: runTickMock }));
vi.mock("@/lib/jobs/run-record", () => ({ recordRun: recordRunMock }));
vi.mock("@/lib/db/runtime", () => ({ getDb: () => "db" }));

import { GET, HEAD, maxDuration, POST } from "./route";
import { logger } from "@/lib/logger";

const SECRET = "c".repeat(40);
const call = (method: "GET" | "POST", authorization?: string) =>
  new Request("http://localhost:3000/api/jobs/run", {
    method,
    headers: authorization ? { authorization } : {},
  });

beforeEach(() => {
  afterMock.mockReset();
  runTickMock.mockClear();
  recordRunMock.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("/api/jobs/run", () => {
  it("keeps Hobby's 300 s maximum", () => {
    expect(maxDuration).toBe(300);
  });

  it("GET with Bearer CRON_SECRET answers 202 and schedules one run with trigger cron", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const response = await GET(call("GET", `Bearer ${SECRET}`));
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(runTickMock).not.toHaveBeenCalled();
    await afterMock.mock.calls[0][0]();
    expect(runTickMock).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      { module: "jobs", trigger: "cron" },
      "jobs: run started",
    );
  });

  it("POST with the secret schedules trigger manual", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const response = await POST(call("POST", `Bearer ${SECRET}`));
    expect(response.status).toBe(202);
    await afterMock.mock.calls[0][0]();
    expect(info).toHaveBeenCalledWith(
      { module: "jobs", trigger: "manual" },
      "jobs: run started",
    );
  });

  it.each([
    ["without a header", "c".repeat(40), undefined],
    ["with a wrong secret", "c".repeat(40), `Bearer ${"d".repeat(40)}`],
    ["with CRON_SECRET unset", "", `Bearer `],
    ["with CRON_SECRET shorter than 32", "c".repeat(31), `Bearer ${"c".repeat(31)}`],
  ])("GET %s answers 401 and schedules nothing", async (_name, secret, header) => {
    vi.stubEnv("CRON_SECRET", secret);
    const response = await GET(call("GET", header));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(afterMock).not.toHaveBeenCalled();
    expect(runTickMock).not.toHaveBeenCalled();
  });

  it("HEAD answers 405 and never starts a run, even with the secret", () => {
    // Next derives HEAD from GET unless the route exports it; that would be a third, mislabelled
    // way to start the daily run.
    vi.stubEnv("CRON_SECRET", SECRET);
    const response = HEAD();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(afterMock).not.toHaveBeenCalled();
    expect(runTickMock).not.toHaveBeenCalled();
  });

  it("runs the housekeeping in the binding order, then records the run with its trigger", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    await GET(call("GET", `Bearer ${SECRET}`));
    await afterMock.mock.calls[0][0]();
    expect(runTickMock.mock.calls[0][0].housekeeping.map((step) => step.name)).toEqual([
      "settleRegenerations",
      "pruneAccounts",
      "backfillSearchText",
      "purgeTrash",
      "purgeExports",
      "sweepMaterials",
      "sweepSolver",
    ]);
    expect(recordRunMock).toHaveBeenCalledTimes(1);
    const [db, input] = recordRunMock.mock.calls[0];
    expect(db).toBe("db");
    expect(input.at).toBeInstanceOf(Date);
    expect(input.trigger).toBe("cron");
    expect(input.result).toEqual(RESULT);
  });

  it("writes no record for a refused request", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    await POST(call("POST", `Bearer ${"x".repeat(40)}`));
    expect(afterMock).not.toHaveBeenCalled();
    expect(recordRunMock).not.toHaveBeenCalled();
  });
});
