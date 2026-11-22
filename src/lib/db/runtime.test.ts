import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDbForTests } from "./runtime";

afterEach(() => {
  resetDbForTests();
  vi.unstubAllEnvs();
});

describe("getDb", () => {
  it("returns one cached client without connecting", () => {
    // Port 1 refuses connections; postgres-js connects lazily, so creating the client is safe.
    vi.stubEnv("DATABASE_URL", "postgresql://user:pw@127.0.0.1:1/db");
    expect(getDb()).toBe(getDb());
  });

  it("turns prepared statements off for the pooled connection", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pw@127.0.0.1:1/db");
    expect(getDb().$client.options.prepare).toBe(false);
  });

  it("throws the Indonesian DATABASE_URL message when it is not configured", () => {
    vi.stubEnv("DATABASE_URL", "");
    expect(() => getDb()).toThrow(/DATABASE_URL/);
  });
});
