import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { profiles, user } from "./schema";
import {
  cleanupHint,
  createThrowawayUser,
  deleteThrowawayUser,
  describeError,
  isNoAccess,
  isPermissionDenied,
  preflightMessage,
  projectRefFromUrl,
  requireStagingConfirmation,
  runChecks,
  summarize,
} from "./staging-rls";
import { createTestDatabase, DB_TEST_TIMEOUT } from "./test-harness";

describe("requireStagingConfirmation", () => {
  it("throws unless --confirm-staging is present", () => {
    expect(() => {
      requireStagingConfirmation([]);
    }).toThrow(/--confirm-staging/);
    expect(() => {
      requireStagingConfirmation(["--other"]);
    }).toThrow(/--confirm-staging/);
  });

  it("names the number of temporary users the script creates", () => {
    expect(() => {
      requireStagingConfirmation([]);
    }).toThrow(/dua pengguna/);
    expect(() => {
      requireStagingConfirmation([], 1);
    }).toThrow(/satu pengguna/);
  });

  it("accepts the flag anywhere in the arguments", () => {
    expect(() => {
      requireStagingConfirmation(["--x", "--confirm-staging"]);
    }).not.toThrow();
  });
});

describe("projectRefFromUrl", () => {
  it("takes the first label of the database host", () => {
    expect(
      projectRefFromUrl(
        "postgresql://u:p@ep-cool-name-123.ap-southeast-1.aws.neon.tech/db",
      ),
    ).toBe("ep-cool-name-123");
    expect(projectRefFromUrl("https://abc123.example.test/")).toBe("abc123");
  });

  it("rejects something that is not a URL", () => {
    expect(() => projectRefFromUrl("not a url")).toThrow();
  });

  it("never puts the URL or its password in an error", () => {
    for (const url of [
      "postgres://u:s3cretPassw0rd@:5432/db",
      "s3cretPassw0rd not a url",
    ]) {
      let message = "";
      try {
        projectRefFromUrl(url);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("s3cretPassw0rd");
      expect(message).not.toContain(url);
    }
  });
});

describe("isNoAccess", () => {
  it("is true for an error, an empty array, or no data", () => {
    expect(isNoAccess({ data: null, error: { code: "42501" } })).toBe(true);
    expect(isNoAccess({ data: [], error: null })).toBe(true);
    expect(isNoAccess({ data: null, error: null })).toBe(true);
  });

  it("is false when rows came back", () => {
    expect(isNoAccess({ data: [{ id: "x" }], error: null })).toBe(false);
  });
});

describe("isPermissionDenied", () => {
  it("is true only for SQLSTATE 42501", () => {
    expect(isPermissionDenied({ code: "42501", message: "permission denied" })).toBe(
      true,
    );
  });

  it("is false for other codes, no error, or non-objects", () => {
    expect(isPermissionDenied({ code: "PGRST205" })).toBe(false);
    expect(isPermissionDenied({ code: "PGRST204" })).toBe(false);
    expect(isPermissionDenied({ message: "fetch failed" })).toBe(false);
    expect(isPermissionDenied(null)).toBe(false);
    expect(isPermissionDenied(undefined)).toBe(false);
    expect(isPermissionDenied("42501")).toBe(false);
  });
});

describe("describeError", () => {
  it("includes the code and message so a failure shows what actually came back", () => {
    expect(describeError({ code: "PGRST205", message: "no table" })).toBe(
      "PGRST205: no table",
    );
    expect(describeError({ message: "fetch failed" })).toBe("fetch failed");
    expect(describeError(null)).toBe("tidak ada error");
  });
});

describe("preflightMessage", () => {
  it("tells the operator to migrate and includes what came back", () => {
    const message = preflightMessage({ code: "PGRST205", message: "no table" });
    expect(message).toContain("Migrasi belum diterapkan di proyek ini");
    expect(message).toContain("pnpm db:migrate");
    expect(message).toContain("PGRST205: no table");
  });

  it("recognises a missing table by SQLSTATE 42P01, also on a wrapped cause", () => {
    expect(preflightMessage({ code: "42P01", message: "x" })).toContain("Migrasi belum");
    expect(
      preflightMessage({
        message: "Failed query",
        cause: { code: "42P01", message: "x" },
      }),
    ).toContain("Migrasi belum");
    expect(preflightMessage(new Error('relation "jobs" does not exist'))).toContain(
      "Migrasi belum",
    );
  });

  it("does not blame the migrations for an unrelated failure", () => {
    const message = preflightMessage(new Error("connect ENETUNREACH"));
    expect(message).not.toContain("Migrasi belum");
    expect(message).toContain("Pemeriksaan awal gagal");
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("connect ENETUNREACH");
  });
});

describe("cleanupHint", () => {
  it("names both throwaway email addresses for manual cleanup", () => {
    const hint = cleanupHint(123);
    expect(hint).toContain("rls-a-123@example.test");
    expect(hint).toContain("rls-b-123@example.test");
  });
});

describe("runChecks and summarize", () => {
  it("runs every check in order, captures failures and never throws", async () => {
    const order: string[] = [];
    const results = await runChecks([
      {
        name: "one",
        run: () => {
          order.push("one");
          return Promise.resolve();
        },
      },
      {
        name: "two",
        run: () => {
          order.push("two");
          return Promise.reject(new Error("boom"));
        },
      },
      {
        name: "three",
        run: () => {
          order.push("three");
          return Promise.resolve();
        },
      },
    ]);
    expect(order).toEqual(["one", "two", "three"]);
    expect(results).toEqual([
      { name: "one", ok: true },
      { name: "two", ok: false, error: "boom" },
      { name: "three", ok: true },
    ]);
    expect(summarize(results)).toEqual({ passed: 2, failed: 1 });
  });
});

describe("createThrowawayUser / deleteThrowawayUser (PGlite, real migrations)", () => {
  it(
    "creates a uuid user row and deleting it cascades through the profile",
    async () => {
      const { db } = await createTestDatabase();
      const id = await createThrowawayUser(db, "throwaway@example.test");
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      await db.insert(profiles).values({ id });

      await deleteThrowawayUser(db, id);

      expect(await db.select().from(user).where(eq(user.id, id))).toEqual([]);
      expect(await db.select().from(profiles).where(eq(profiles.id, id))).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );
});
