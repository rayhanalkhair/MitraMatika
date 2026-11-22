import { describe, expect, it } from "vitest";
import { assertLocalE2eDatabase, isLocalE2eDatabase } from "./e2e-guard";

const ok = (url: string) => isLocalE2eDatabase({ DATABASE_URL: url, E2E_CI: "1" });

describe("isLocalE2eDatabase", () => {
  it("accepts localhost and 127.0.0.1 with E2E_CI=1", () => {
    expect(ok("postgres://postgres:postgres@localhost:5432/mitramatika")).toBe(true);
    expect(ok("postgresql://postgres:pw@127.0.0.1:5432/db")).toBe(true);
    expect(ok("postgres://localhost/db")).toBe(true);
  });

  it("rejects when E2E_CI is not exactly 1", () => {
    const url = "postgres://postgres@localhost:5432/db";
    for (const E2E_CI of [undefined, "", "0", "true", " 1"]) {
      expect(isLocalE2eDatabase({ DATABASE_URL: url, E2E_CI })).toBe(false);
    }
  });

  it("rejects missing, empty and unparseable URLs", () => {
    expect(isLocalE2eDatabase({ E2E_CI: "1" })).toBe(false);
    expect(ok("")).toBe(false);
    expect(ok("not a url")).toBe(false);
    expect(ok("localhost:5432/db")).toBe(false);
    expect(ok("postgres://")).toBe(false);
  });

  it("rejects remote and hosted-Postgres hosts", () => {
    expect(
      ok("postgres://app:pw@ep-cool-name-123456.ap-southeast-1.aws.neon.tech/neondb"),
    ).toBe(false);
    expect(
      ok(
        "postgres://app:pw@ep-cool-name-123456-pooler.ap-southeast-1.aws.neon.tech:5432/neondb",
      ),
    ).toBe(false);
    expect(ok("postgres://example.com/db")).toBe(false);
  });

  it("rejects hosts that merely contain a local name", () => {
    expect(ok("postgres://localhost.evil.com/db")).toBe(false);
    expect(ok("postgres://evil-localhost/db")).toBe(false);
    expect(ok("postgres://evil.localhost.com/db")).toBe(false);
    expect(ok("postgres://127.0.0.1.evil.com/db")).toBe(false);
    expect(ok("postgres://1127.0.0.1/db")).toBe(false);
  });

  it("is not fooled by userinfo or query tricks", () => {
    expect(ok("postgres://localhost@evil.com/db")).toBe(false);
    expect(ok("postgres://localhost:pw@evil.com/db")).toBe(false);
    expect(ok("postgres://127.0.0.1@evil.com:5432/db")).toBe(false);
    expect(ok("postgres://evil.com/db?host=localhost")).toBe(false);
    expect(ok("postgres://evil.com/localhost")).toBe(false);
  });

  it("rejects other local-looking hosts and non-postgres schemes", () => {
    expect(ok("postgres://[::1]:5432/db")).toBe(false);
    expect(ok("postgres://0.0.0.0/db")).toBe(false);
    expect(ok("http://localhost/db")).toBe(false);
  });
});

describe("assertLocalE2eDatabase", () => {
  it("does not throw for a local database", () => {
    expect(() => {
      assertLocalE2eDatabase({ DATABASE_URL: "postgres://localhost/db", E2E_CI: "1" });
    }).not.toThrow();
  });

  it("throws a clear message otherwise", () => {
    expect(() => {
      assertLocalE2eDatabase({
        DATABASE_URL: "postgres://ep-x.aws.neon.tech/db",
        E2E_CI: "1",
      });
    }).toThrow(/E2E_CI=1/);
    expect(() => {
      assertLocalE2eDatabase({ DATABASE_URL: "postgres://localhost/db" });
    }).toThrow(/localhost/);
  });
});
