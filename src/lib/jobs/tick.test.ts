import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/lib/logger";
import type { RunSummary } from "./runner";
import {
  HOUSEKEEPING_CUTOFF_MS,
  MIN_RUNNER_MS,
  MIN_STEP_MS,
  runTick,
  stepBudgetMs,
  TICK_BUDGET_MS,
  type HousekeepingStep,
  type StepName,
  type StepReport,
} from "./tick";

const SUMMARY: RunSummary = {
  ran: 2,
  succeeded: 2,
  continued: 0,
  deferred: 0,
  retried: 0,
  failed: 0,
  lostLease: 0,
  reclaimed: 0,
  budgetExhausted: false,
};

const NAMES: StepName[] = [
  "settleRegenerations",
  "pruneAccounts",
  "backfillSearchText",
  "purgeTrash",
  "purgeExports",
  "sweepMaterials",
  "sweepSolver",
];

/** A fake clock and the seven steps in the route's order, each taking `ms` of it. */
function setup(
  stepsMs: number[],
  options: { startedAt?: number; reports?: StepReport[] } = {},
) {
  const startedAt = options.startedAt ?? 1_000;
  let now = startedAt;
  const order: string[] = [];
  const housekeeping: HousekeepingStep[] = stepsMs.map((ms, index) => ({
    name: NAMES[index],
    run: () => {
      order.push(NAMES[index]);
      now += ms;
      return Promise.resolve(options.reports?.[index] ?? {});
    },
  }));
  const runJobs = vi.fn((budgetMs: number) => {
    order.push(`jobs:${String(budgetMs)}`);
    return Promise.resolve(SUMMARY);
  });
  return { housekeeping, runJobs, order, clock: () => now, startedAt };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runTick", () => {
  it("pins the daily budget: 240 s in all, no step started after 120 s, the runner needs 30 s", () => {
    expect(TICK_BUDGET_MS).toBe(240_000);
    expect(HOUSEKEEPING_CUTOFF_MS).toBe(120_000);
    expect(MIN_RUNNER_MS).toBe(30_000);
  });

  it("all fast steps run in order and the runner gets about 240 s", async () => {
    const t = setup([100, 100, 100, 100, 100, 100, 100]);
    const result = await runTick(t);
    expect(t.order).toEqual([...NAMES, `jobs:${String(TICK_BUDGET_MS - 700)}`]);
    expect(result.steps).toEqual(
      NAMES.map((name) => ({ name, outcome: "ran", ms: 100 })),
    );
    expect(result.jobs).toBe(SUMMARY);
    expect(result.budgetMs).toBe(TICK_BUDGET_MS - 700);
  });

  it("counts the time since the request, not since the first step", async () => {
    const t = setup([10_000]);
    // The request came in 20 s before the scheduled task started.
    await runTick({ ...t, startedAt: t.startedAt - 20_000 });
    expect(t.runJobs).toHaveBeenCalledWith(TICK_BUDGET_MS - 30_000);
  });

  it("a step is not started at or after 120 s and is reported skipped", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const t = setup([60_000, 60_000, 1_000]);
    const result = await runTick(t);
    expect(t.order).toEqual([
      "settleRegenerations",
      "pruneAccounts",
      `jobs:${String(TICK_BUDGET_MS - HOUSEKEEPING_CUTOFF_MS)}`,
    ]);
    expect(result.steps[2]).toEqual({
      name: "backfillSearchText",
      outcome: "skipped",
      ms: 0,
      backlogLeft: true,
    });
    expect(warn).toHaveBeenCalledWith(
      { module: "jobs", skipped: ["backfillSearchText"] },
      "jobs: housekeeping steps skipped after the cutoff; they run on the next daily run",
    );
  });

  it("gives each step the time left before the cutoff, so none can run past it on its own cap", async () => {
    const t = setup([100_000, 15_000]);
    const budgets: number[] = [];
    const housekeeping = t.housekeeping.map((step) => ({
      ...step,
      run: (budgetMs: number) => {
        budgets.push(budgetMs);
        return step.run(budgetMs);
      },
    }));
    await runTick({ ...t, housekeeping });
    expect(budgets).toEqual([HOUSEKEEPING_CUTOFF_MS, HOUSEKEEPING_CUTOFF_MS - 100_000]);
  });

  it("stepBudgetMs is the smaller of a step's own cap and the time left, never negative", () => {
    expect(stepBudgetMs(30_000, 120_000)).toBe(30_000);
    expect(stepBudgetMs(30_000, 100)).toBe(100);
    expect(stepBudgetMs(30_000, -5)).toBe(0);
    expect(stepBudgetMs(30_000)).toBe(30_000);
  });

  it("does not start a step with less than the minimum slice left before the cutoff", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    expect(MIN_STEP_MS).toBe(5_000);
    // The trash purge would start at 118 s: it is skipped, so it cannot claim the day.
    const t = setup([5_000, 5_000, 108_000, 1_000]);
    const result = await runTick(t);
    expect(t.order).not.toContain("purgeTrash");
    expect(result.steps[3]).toEqual({
      name: "purgeTrash",
      outcome: "skipped",
      ms: 0,
      backlogLeft: true,
    });
  });

  it("starts a step with exactly the minimum slice left", async () => {
    const t = setup([HOUSEKEEPING_CUTOFF_MS - MIN_STEP_MS, 1_000]);
    const result = await runTick(t);
    expect(result.steps.map((s) => s.outcome)).toEqual(["ran", "ran"]);
  });

  it("worst case (5, 5, 5, 105, 45, 32, 25 s) runs the first four, skips the rest and gives the runner at least 90 s", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const t = setup([5_000, 5_000, 5_000, 105_000, 45_000, 32_000, 25_000]);
    const result = await runTick(t);
    expect(result.steps.map((s) => [s.name, s.outcome, s.ms])).toEqual([
      ["settleRegenerations", "ran", 5_000],
      ["pruneAccounts", "ran", 5_000],
      ["backfillSearchText", "ran", 5_000],
      ["purgeTrash", "ran", 105_000],
      ["purgeExports", "skipped", 0],
      ["sweepMaterials", "skipped", 0],
      ["sweepSolver", "skipped", 0],
    ]);
    expect(result.budgetMs).toBeGreaterThanOrEqual(90_000);
    expect(t.runJobs).toHaveBeenCalledWith(120_000);
  });

  it("a throwing step is reported failed and the next one runs", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const t = setup([1_000, 1_000]);
    const failing: HousekeepingStep = {
      name: "settleRegenerations",
      run: () => Promise.reject(new Error("boom")),
    };
    const result = await runTick({
      ...t,
      housekeeping: [failing, ...t.housekeeping.slice(1)],
    });
    expect(result.steps.map((s) => [s.name, s.outcome])).toEqual([
      ["settleRegenerations", "failed"],
      ["pruneAccounts", "ran"],
    ]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toMatchObject({
      module: "jobs",
      step: "settleRegenerations",
    });
  });

  it("a step that reports its own failure is recorded failed", async () => {
    const t = setup([1_000], { reports: [{ failed: true }] });
    const result = await runTick(t);
    expect(result.steps[0].outcome).toBe("failed");
  });

  it("a step that stops on its budget reports backlogLeft", async () => {
    const t = setup([1_000, 1_000], { reports: [{ backlogLeft: true }, {}] });
    const result = await runTick(t);
    expect(result.steps[0]).toEqual({
      name: "settleRegenerations",
      outcome: "ran",
      ms: 1_000,
      backlogLeft: true,
    });
    expect(result.steps[1]).not.toHaveProperty("backlogLeft");
  });

  it("with less than 30 s left the runner is skipped and jobs is null", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const t = setup([TICK_BUDGET_MS - MIN_RUNNER_MS + 1]);
    const result = await runTick(t);
    expect(result.jobs).toBeNull();
    expect(t.runJobs).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ module: "jobs" }),
      "jobs: housekeeping used the run's budget; the jobs run on the next run",
    );
  });

  it("a runner that throws still yields the steps, jobs null and the error name only", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const t = setup([1_000, 1_000]);
    const runJobs = vi.fn(() =>
      Promise.reject(new TypeError("connection to secret-host lost")),
    );
    const result = await runTick({ ...t, runJobs });
    expect(result.steps.map((s) => [s.name, s.outcome])).toEqual([
      ["settleRegenerations", "ran"],
      ["pruneAccounts", "ran"],
    ]);
    expect(result.jobs).toBeNull();
    expect(result.jobsError).toBe("TypeError");
    expect(result.budgetMs).toBe(TICK_BUDGET_MS - 2_000);
    expect(error).toHaveBeenCalledWith(
      { module: "jobs", err: "TypeError" },
      "jobs: the job runner failed",
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret-host");
  });

  it("runs the jobs at exactly the floor", async () => {
    const t = setup([TICK_BUDGET_MS - MIN_RUNNER_MS]);
    await runTick(t);
    expect(t.runJobs).toHaveBeenCalledWith(MIN_RUNNER_MS);
  });
});
