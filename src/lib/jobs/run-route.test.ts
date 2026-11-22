import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRunRequest, type RunTrigger } from "./run-route";
import { logger } from "@/lib/logger";

const SECRET = "s".repeat(40);
const call = (method: "GET" | "POST", authorization?: string) =>
  new Request("http://localhost:3000/api/jobs/run", {
    method,
    headers: authorization ? { authorization } : {},
  });
const post = (authorization?: string) => call("POST", authorization);
const get = (authorization?: string) => call("GET", authorization);

function setup() {
  const scheduled: (() => Promise<void>)[] = [];
  const run = vi.fn<(trigger: RunTrigger) => Promise<void>>(() => Promise.resolve());
  return {
    scheduled,
    run,
    schedule: (task: () => Promise<void>) => scheduled.push(task),
  };
}

describe("handleRunRequest", () => {
  it("GET with Bearer CRON_SECRET answers 202 and schedules one run with trigger cron", async () => {
    const { scheduled, run, schedule } = setup();
    const response = handleRunRequest(
      get(`Bearer ${SECRET}`),
      SECRET,
      schedule,
      run,
      "cron",
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(scheduled).toHaveLength(1);
    await scheduled[0]();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("cron");
  });

  it("POST with the secret schedules trigger manual", async () => {
    const { scheduled, run, schedule } = setup();
    const response = handleRunRequest(
      post(`Bearer ${SECRET}`),
      SECRET,
      schedule,
      run,
      "manual",
    );
    expect(response.status).toBe(202);
    await scheduled[0]();
    expect(run).toHaveBeenCalledWith("manual");
  });

  it.each([
    ["no header", undefined],
    ["a wrong secret", `Bearer ${"t".repeat(40)}`],
    ["a wrong scheme", `Basic ${SECRET}`],
  ])("GET or POST returns 401 and schedules nothing for %s", async (_name, header) => {
    for (const [request, trigger] of [
      [get(header), "cron"],
      [post(header), "manual"],
    ] as const) {
      const { scheduled, run, schedule } = setup();
      const response = handleRunRequest(request, SECRET, schedule, run, trigger);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
      expect(scheduled).toHaveLength(0);
      expect(run).not.toHaveBeenCalled();
    }
  });

  it.each([undefined, "", "a".repeat(31)])(
    "GET returns 401 for every request when CRON_SECRET is %j (unset or shorter than 32)",
    (secret) => {
      const { scheduled, run, schedule } = setup();
      const response = handleRunRequest(
        get(`Bearer ${secret ?? ""}`),
        secret,
        schedule,
        run,
        "cron",
      );
      expect(response.status).toBe(401);
      expect(scheduled).toHaveLength(0);
    },
  );

  it("schedules the run after the response, not before", () => {
    const { scheduled, run, schedule } = setup();
    handleRunRequest(post(`Bearer ${SECRET}`), SECRET, schedule, run, "manual");
    expect(scheduled).toHaveLength(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("logs a failing run instead of letting it escape the scheduled task", async () => {
    const { scheduled, schedule } = setup();
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const run = vi.fn(() => {
      return Promise.reject(new Error("db down"));
    });
    handleRunRequest(post(`Bearer ${SECRET}`), SECRET, schedule, run, "manual");
    await expect(scheduled[0]()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("never marks the response cacheable, accepted or not", () => {
    const { schedule, run } = setup();
    expect(
      handleRunRequest(get(), SECRET, schedule, run, "cron").headers.get("cache-control"),
    ).toBe("no-store");
    expect(
      handleRunRequest(
        get(`Bearer ${SECRET}`),
        SECRET,
        schedule,
        run,
        "cron",
      ).headers.get("cache-control"),
    ).toBe("no-store");
  });
});

describe("a misconfigured CRON_SECRET in production", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function fresh() {
    vi.resetModules();
    const route = await import("./run-route");
    const { logger: freshLogger } = await import("@/lib/logger");
    const warn = vi.spyOn(freshLogger, "warn").mockImplementation(() => undefined);
    return { handle: route.handleRunRequest, warn };
  }

  it.each([undefined, "a".repeat(31)])(
    "warns once per process when the secret is %j, naming no value",
    async (secret) => {
      vi.stubEnv("NODE_ENV", "production");
      const { handle, warn } = await fresh();
      const { schedule, run } = setup();
      const header = `Bearer ${"z".repeat(40)}`;
      handle(get(header), secret, schedule, run, "cron");
      handle(get(header), secret, schedule, run, "cron");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        { module: "jobs" },
        "jobs: CRON_SECRET is unset or shorter than 32 characters; every run is refused",
      );
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain("z".repeat(40));
      if (secret) expect(logged).not.toContain(secret);
    },
  );

  it("does not warn on a wrong token when the secret is valid", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { handle, warn } = await fresh();
    const { schedule, run } = setup();
    handle(get(`Bearer ${"t".repeat(40)}`), SECRET, schedule, run, "cron");
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { handle, warn } = await fresh();
    const { schedule, run } = setup();
    handle(get(), undefined, schedule, run, "cron");
    expect(warn).not.toHaveBeenCalled();
  });
});
