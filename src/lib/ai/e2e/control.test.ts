import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getE2eAiState,
  isFakeAiEnabled,
  resetE2eAi,
  setScenario,
  SCENARIOS,
} from "./control";

afterEach(() => {
  vi.unstubAllEnvs();
  resetE2eAi();
});

describe("isFakeAiEnabled", () => {
  it("is off without the flag", () => {
    expect(isFakeAiEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(isFakeAiEnabled({ E2E_FAKE_AI: "0", NODE_ENV: "development" })).toBe(false);
    expect(isFakeAiEnabled({})).toBe(false);
  });

  it("is off in production even with the flag", () => {
    expect(isFakeAiEnabled({ E2E_FAKE_AI: "1", NODE_ENV: "production" })).toBe(false);
  });

  it("is off when the real process NODE_ENV is production, whatever env is injected", () => {
    // The literal process.env.NODE_ENV check is what a production bundle folds to false.
    vi.stubEnv("NODE_ENV", "production");
    expect(isFakeAiEnabled({ E2E_FAKE_AI: "1", NODE_ENV: "development" })).toBe(false);
    expect(isFakeAiEnabled({ E2E_FAKE_AI: "1" })).toBe(false);
  });

  it("is on with the flag outside production", () => {
    expect(isFakeAiEnabled({ E2E_FAKE_AI: "1", NODE_ENV: "development" })).toBe(true);
    expect(isFakeAiEnabled({ E2E_FAKE_AI: "1", NODE_ENV: "test" })).toBe(true);
    // An allow-list: unset or any other NODE_ENV is off.
    for (const nodeEnv of [undefined, "", "staging", "preview"]) {
      expect(
        isFakeAiEnabled({ E2E_FAKE_AI: "1", NODE_ENV: nodeEnv }),
        String(nodeEnv),
      ).toBe(false);
    }
  });
});

describe("e2e AI state", () => {
  it("defaults to the valid scenario with empty counters", () => {
    expect(getE2eAiState()).toEqual({
      scenario: "valid",
      calls: { generate: 0, regenerate: 0, solver: 0 },
      log: [],
    });
  });

  it("lists every scenario", () => {
    expect([...SCENARIOS].sort()).toEqual([
      "invented_citation",
      "malformed_repairable",
      "malformed_twice",
      "rate_limited",
      "valid",
      "wrong_key_persistent",
    ]);
  });

  it("setScenario selects it and clears counters and log", () => {
    const state = getE2eAiState();
    state.calls.generate = 3;
    state.log.push("x");
    setScenario("malformed_twice");
    expect(getE2eAiState()).toEqual({
      scenario: "malformed_twice",
      calls: { generate: 0, regenerate: 0, solver: 0 },
      log: [],
    });
  });

  it("resetE2eAi returns to the default", () => {
    setScenario("rate_limited");
    getE2eAiState().calls.solver = 2;
    resetE2eAi();
    expect(getE2eAiState().scenario).toBe("valid");
    expect(getE2eAiState().calls.solver).toBe(0);
  });

  it("keeps one state object on globalThis across module reloads", () => {
    setScenario("malformed_twice");
    expect((globalThis as { __e2eAi?: { scenario: string } }).__e2eAi?.scenario).toBe(
      "malformed_twice",
    );
  });
});
