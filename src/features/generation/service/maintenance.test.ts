import { beforeEach, describe, expect, it, vi } from "vitest";

const { settle, error, info } = vi.hoisted(() => ({
  settle: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/runtime", () => ({ getDb: () => "db" }));
vi.mock("./regenerate", () => ({ settleStrandedApprovals: settle }));
vi.mock("@/lib/logger", () => ({ logger: { error, info } }));

import { settleStrandedRegenerations } from "./maintenance";

const NOW = new Date("2026-12-09T01:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("settleStrandedRegenerations", () => {
  it("settles on the service connection and logs how many changed", async () => {
    settle.mockResolvedValue(2);
    expect(await settleStrandedRegenerations(NOW)).toEqual({});
    expect(settle).toHaveBeenCalledWith("db", NOW);
    expect(info).toHaveBeenCalledWith(
      { module: "generation", settled: 2 },
      expect.any(String),
    );
  });

  it("logs nothing when nothing was stranded", async () => {
    settle.mockResolvedValue(0);
    await settleStrandedRegenerations(NOW);
    expect(info).not.toHaveBeenCalled();
  });

  it("never throws, and logs no SQL text", async () => {
    settle.mockRejectedValue(
      Object.assign(new Error("update questions ... Hitung rahasia"), { code: "57P01" }),
    );
    await expect(settleStrandedRegenerations(NOW)).resolves.toEqual({ failed: true });
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls)).not.toContain("rahasia");
    expect(JSON.stringify(error.mock.calls)).toContain("57P01");
  });
});
