import { beforeEach, describe, expect, it, vi } from "vitest";

const { backfill, error, info } = vi.hoisted(() => ({
  backfill: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/runtime", () => ({ getDb: () => "db" }));
vi.mock("./backfill-search-text", () => ({ backfillSearchText: backfill }));
vi.mock("@/lib/logger", () => ({ logger: { error, info } }));

import { backfillBankSearchText } from "./maintenance";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("backfillBankSearchText", () => {
  it("runs a bounded backfill on the service connection and logs what it filled", async () => {
    backfill.mockResolvedValue(7);
    expect(await backfillBankSearchText()).toEqual({});
    expect(backfill).toHaveBeenCalledWith("db", {
      maxBatches: 10,
      outOfTime: expect.any(Function) as unknown,
      onOutOfTime: expect.any(Function) as unknown,
    });
    expect(info).toHaveBeenCalledWith({ module: "bank", filled: 7 }, expect.any(String));
  });

  it("reports a backlog when its time ran out", async () => {
    backfill.mockImplementation(
      (_db: unknown, options: { outOfTime: () => boolean; onOutOfTime: () => void }) => {
        if (options.outOfTime()) options.onOutOfTime();
        return Promise.resolve(0);
      },
    );
    expect(await backfillBankSearchText(0)).toEqual({ backlogLeft: true });
  });

  it("never throws: a failure is logged", async () => {
    backfill.mockRejectedValue(new Error("db down"));
    await expect(backfillBankSearchText()).resolves.toEqual({ failed: true });
    expect(error).toHaveBeenCalled();
  });

  it("logs only the error name and code, never the bound question text", async () => {
    backfill.mockRejectedValue(
      Object.assign(new Error("update questions set search_text = 'hitung rahasia'"), {
        cause: { code: "57P01" },
      }),
    );
    await backfillBankSearchText();
    // The logger would serialise an Error with its message: only a plain summary may reach it.
    expect(error).toHaveBeenCalledWith(
      { module: "bank", err: { name: "Error", code: "57P01" } },
      expect.any(String),
    );
  });
});
