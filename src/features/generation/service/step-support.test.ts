import { describe, expect, it } from "vitest";
import {
  lockWaitMs,
  MAX_PROVIDER_DEFERRALS,
  MIN_REMAINING_MS,
  pgCodeOf,
  PROVIDER_RETRY_CEIL_MS,
  PROVIDER_RETRY_FLOOR_MS,
  providerRetryDelayMs,
} from "./step-support";

describe("pgCodeOf", () => {
  it("reads the code on the error and along its cause chain", () => {
    expect(pgCodeOf({ code: "55P03" })).toBe("55P03");
    expect(pgCodeOf(new Error("x", { cause: { cause: { code: "23505" } } }))).toBe(
      "23505",
    );
  });

  it("returns an empty string when there is none", () => {
    expect(pgCodeOf(new Error("plain"))).toBe("");
    expect(pgCodeOf("text")).toBe("");
  });
});

describe("lockWaitMs", () => {
  it("leaves the minimum remaining time for the call itself", () => {
    expect(lockWaitMs(1_000_000 + 240_000, 1_000_000)).toBe(240_000 - MIN_REMAINING_MS);
  });

  it("never goes below one second", () => {
    expect(lockWaitMs(1_000_000 + 10_000, 1_000_000)).toBe(1_000);
  });
});

describe("providerRetryDelayMs", () => {
  it("floors a short or missing retry-after at one minute", () => {
    expect(providerRetryDelayMs(undefined)).toBe(PROVIDER_RETRY_FLOOR_MS);
    expect(providerRetryDelayMs(5_000)).toBe(PROVIDER_RETRY_FLOOR_MS);
  });

  it("keeps a wait inside the window and caps a long one", () => {
    expect(providerRetryDelayMs(120_000)).toBe(120_000);
    expect(providerRetryDelayMs(10 * 3_600_000)).toBe(PROVIDER_RETRY_CEIL_MS);
  });

  it("allows five deferrals per job", () => {
    expect(MAX_PROVIDER_DEFERRALS).toBe(5);
  });
});
