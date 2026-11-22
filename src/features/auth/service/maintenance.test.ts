import { beforeEach, describe, expect, it, vi } from "vitest";

const { pruneUsers, pruneLimits, error, info } = vi.hoisted(() => ({
  pruneUsers: vi.fn(),
  pruneLimits: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/runtime", () => ({ getDb: () => "db" }));
vi.mock("./prune-unverified", () => ({ pruneUnverifiedUsers: pruneUsers }));
vi.mock("./prune-limit-rows", () => ({ pruneExpiredLimitRows: pruneLimits }));
vi.mock("@/lib/logger", () => ({ logger: { error, info } }));

import { pruneUnverifiedAccounts } from "./maintenance";

const NOW = new Date("2026-12-09T01:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  pruneUsers.mockResolvedValue(0);
  pruneLimits.mockResolvedValue(undefined);
});

describe("pruneUnverifiedAccounts", () => {
  it("prunes accounts and limit rows and reports a clean step", async () => {
    expect(await pruneUnverifiedAccounts(NOW)).toEqual({});
    expect(pruneUsers).toHaveBeenCalledWith("db", NOW);
    expect(pruneLimits).toHaveBeenCalledWith("db", NOW);
  });

  it.each([
    ["the account prune", () => pruneUsers.mockRejectedValue(new Error("db down"))],
    ["the limit-row prune", () => pruneLimits.mockRejectedValue(new Error("db down"))],
  ])("never throws, and reports the step failed when %s fails", async (_name, fail) => {
    fail();
    await expect(pruneUnverifiedAccounts(NOW)).resolves.toEqual({ failed: true });
    expect(error).toHaveBeenCalledTimes(1);
  });
});
