import { beforeEach, describe, expect, it, vi } from "vitest";

const { purge, error, info, getStore } = vi.hoisted(() => ({
  purge: vi.fn(),
  getStore: vi.fn(() => "store"),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/runtime", () => ({ getDb: () => "db" }));
vi.mock("./purge", () => ({
  purgeTrashOncePerDay: purge,
  TRASH_PURGE_BUDGET_MS: 60_000,
}));
vi.mock("@/lib/storage", () => ({ getObjectStore: getStore }));
vi.mock("@/lib/logger", () => ({ logger: { error, info } }));

import { purgeTrash } from "./maintenance";

const NOW = new Date("2026-12-09T01:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("purgeTrash", () => {
  it("runs the daily purge on the service connection with the object store and logs how many went", async () => {
    purge.mockResolvedValue({ purged: 3, failed: 1 });
    expect(await purgeTrash(NOW)).toEqual({});
    expect(purge).toHaveBeenCalledWith("db", NOW, expect.any(Function), {
      budgetMs: 60_000,
      onBacklog: expect.any(Function) as unknown,
    });
    // The object store is handed over lazily: only a row with files to delete asks for it, so a
    // deploy without one still purges the rest.
    expect(getStore).not.toHaveBeenCalled();
    const source = purge.mock.calls[0][2] as () => unknown;
    expect(source()).toBe("store");
    expect(info).toHaveBeenCalledWith(
      { module: "trash", purged: 3, failed: 1 },
      expect.any(String),
    );
  });

  it("logs nothing when today's purge already ran", async () => {
    purge.mockResolvedValue(null);
    await purgeTrash(NOW);
    expect(info).not.toHaveBeenCalled();
  });

  it("never throws: a failure is logged", async () => {
    purge.mockRejectedValue(new Error("db down"));
    await expect(purgeTrash(NOW)).resolves.toEqual({ failed: true });
    expect(error).toHaveBeenCalled();
  });

  it("never takes rows past the run's cutoff: its budget is the time left when that is shorter", async () => {
    purge.mockResolvedValue(null);
    await purgeTrash(NOW, 20_000);
    expect((purge.mock.calls[0][3] as { budgetMs: number }).budgetMs).toBe(20_000);
    await purgeTrash(NOW, 500_000);
    expect((purge.mock.calls[1][3] as { budgetMs: number }).budgetMs).toBe(60_000);
  });

  it("does not start (and so never claims the day) with less than the minimum slice", async () => {
    expect(await purgeTrash(NOW, 2_000)).toEqual({ backlogLeft: true });
    expect(purge).not.toHaveBeenCalled();
  });

  it("reports a backlog when the purge's budget stopped it", async () => {
    purge.mockImplementation(
      (_db: unknown, _now: Date, _store: unknown, options: { onBacklog: () => void }) => {
        options.onBacklog();
        return Promise.resolve({ purged: 1, failed: 0 });
      },
    );
    expect(await purgeTrash(NOW)).toEqual({ backlogLeft: true });
  });
});
