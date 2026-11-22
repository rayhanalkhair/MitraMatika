import { beforeEach, describe, expect, it, vi } from "vitest";

const afterMock = vi.fn<(task: () => Promise<void>) => void>();
vi.mock("next/server", () => ({
  after: (task: () => Promise<void>) => {
    afterMock(task);
  },
}));

import { scheduleRun } from "./trigger";
import { logger } from "@/lib/logger";

beforeEach(() => {
  afterMock.mockReset();
});

describe("scheduleRun", () => {
  it("schedules the run with after() without running it inline", () => {
    const run = vi.fn(() => Promise.resolve());
    scheduleRun(run);
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the job runner when the scheduled task executes", async () => {
    const run = vi.fn(() => Promise.resolve());
    scheduleRun(run);
    await afterMock.mock.calls[0][0]();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("swallows and logs a failing run so it never affects the response", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    scheduleRun(() => {
      return Promise.reject(new Error("boom"));
    });
    await expect(afterMock.mock.calls[0][0]()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
