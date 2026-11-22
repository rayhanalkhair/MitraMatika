import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getDb = vi.fn<() => unknown>();
vi.mock("@/lib/db/runtime", () => ({ getDb: () => getDb() }));

import { audit, error, usage } from "./index";
import { logger } from "@/lib/logger";

beforeEach(() => {
  getDb.mockReset();
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("default recorders", () => {
  it("return false instead of throwing when the database is not configured", async () => {
    getDb.mockImplementation(() => {
      throw new Error("DATABASE_URL tidak ditemukan");
    });
    expect(await audit({ ownerId: "u", action: "sign_in" })).toBe(false);
    expect(await usage({ ownerId: "u", event: "task_done" })).toBe(false);
    expect(await error({ source: "web", message: "m" })).toBe(false);
  });

  it("write through the runtime database when it is available", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    getDb.mockReturnValue({ insert: () => ({ values }) });
    expect(
      await audit({
        ownerId: "11111111-1111-4111-8111-111111111111",
        action: "sign_in",
      }),
    ).toBe(true);
    expect(values).toHaveBeenCalledTimes(1);
  });
});
