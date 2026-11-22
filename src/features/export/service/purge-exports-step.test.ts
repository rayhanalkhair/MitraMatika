import { beforeEach, describe, expect, it, vi } from "vitest";

const { error, info } = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/storage", () => ({ getObjectStore: () => "store" }));
vi.mock("@/lib/storage/bounded", () => ({ boundObjectStore: (store: unknown) => store }));
vi.mock("@/lib/logger", () => ({ logger: { error, info, warn: vi.fn() } }));

import { purgeExports } from "./purge-exports";

const NOW = new Date("2026-12-09T01:00:00.000Z");

/** A database whose expired-row select answers `rows`, and whose delete works. */
function fakeDb(rows: { id: string; ownerId: string; objectKey: string }[] | Error) {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => (rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows)),
  };
  return { select: () => chain, delete: () => ({ where: () => Promise.resolve() }) };
}

let db: ReturnType<typeof fakeDb>;
vi.mock("@/lib/db/runtime", () => ({ getDb: () => db }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("purgeExports (the daily run's step)", () => {
  it("reports a clean step when nothing expired", async () => {
    db = fakeDb([]);
    expect(await purgeExports(NOW)).toEqual({});
  });

  it("takes no row once the time left before the cutoff is spent, and reports the backlog", async () => {
    db = fakeDb([{ id: "x", ownerId: "o", objectKey: "exports/o/j/a.pdf" }]);
    expect(await purgeExports(NOW, 0)).toEqual({ backlogLeft: true });
  });

  it("never throws and reports the step failed when the purge fails", async () => {
    db = fakeDb(new Error("db down"));
    expect(await purgeExports(NOW)).toEqual({ failed: true });
    expect(error).toHaveBeenCalledTimes(1);
  });
});
