import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/lib/logger";
import { runAfterResponse } from "./background";

beforeEach(() => {
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runAfterResponse", () => {
  it("hands the task to Next's after() inside a request", async () => {
    const schedule = vi.fn<(callback: () => Promise<unknown>) => void>();
    const task = Promise.resolve("sent");
    runAfterResponse(task, schedule);
    expect(schedule).toHaveBeenCalledTimes(1);
    await expect(schedule.mock.calls[0][0]()).resolves.toBe("sent");
  });

  it("lets the task run on its own outside a request scope, without throwing", async () => {
    let finished = false;
    const task = Promise.resolve().then(() => {
      finished = true;
    });
    expect(() => {
      runAfterResponse(task, () => {
        throw new Error("`after` was called outside a request scope.");
      });
    }).not.toThrow();
    await task;
    expect(finished).toBe(true);
  });

  it("does not throw with the real after() outside a request (tests, scripts)", async () => {
    const task = Promise.resolve();
    expect(() => {
      runAfterResponse(task);
    }).not.toThrow();
    await task;
  });

  it("does not log the expected outside-a-request refusal", () => {
    runAfterResponse(Promise.resolve(), () => {
      throw new Error("`after` was called outside a request scope. Read more: x");
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs any other scheduling failure once, by name only, and never throws", () => {
    expect(() => {
      runAfterResponse(Promise.resolve(), () => {
        throw new RangeError("secret-detail the address a@b.co");
      });
    }).not.toThrow();
    expect(logger.error).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(vi.mocked(logger.error).mock.calls);
    expect(logged).toContain("RangeError");
    expect(logged).not.toContain("secret-detail");
    expect(logged).not.toContain("a@b.co");
  });

  it("logs a thrown non-Error as unknown", () => {
    expect(() => {
      runAfterResponse(Promise.resolve(), () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "boom";
      });
    }).not.toThrow();
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).toContain("unknown");
  });
});
