import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertBuildEnv,
  createAppEnv,
  ENV_KEYS,
  getEnv,
  requireDatabaseUrl,
  requireGoogleApiKey,
  requireBetterAuthSecret,
  requireBetterAuthUrl,
  requireGroqApiKey,
  shouldSkipValidation,
} from "./env";

describe("getEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns undefined for keys that are not set", () => {
    vi.stubEnv("GROQ_API_KEY", "");
    vi.stubEnv("GOOGLE_API_KEY", "");
    delete process.env.GROQ_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    const env = getEnv();
    expect(env.GROQ_API_KEY).toBeUndefined();
    expect(env.GOOGLE_API_KEY).toBeUndefined();
  });

  it("returns the value when set", () => {
    vi.stubEnv("GROQ_API_KEY", "gsk_test123");
    const env = getEnv();
    expect(env.GROQ_API_KEY).toBe("gsk_test123");
  });

  it("env schema has no allowlist variable (sign-up is open)", () => {
    expect(ENV_KEYS.filter((key) => key.includes("ALLOWED"))).toEqual([]);
  });
});

describe("requireGroqApiKey", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the key when set", () => {
    vi.stubEnv("GROQ_API_KEY", "gsk_test123");
    expect(requireGroqApiKey()).toBe("gsk_test123");
  });

  it("throws a clear message when missing", () => {
    delete process.env.GROQ_API_KEY;
    expect(() => requireGroqApiKey()).toThrow(/GROQ_API_KEY/);
  });
});

describe("requireGoogleApiKey", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws a clear message when missing", () => {
    delete process.env.GOOGLE_API_KEY;
    expect(() => requireGoogleApiKey()).toThrow(/GOOGLE_API_KEY/);
  });
});

describe("requireBetterAuthSecret", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the value when it has at least 32 characters", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "s".repeat(32));
    expect(requireBetterAuthSecret()).toBe("s".repeat(32));
  });

  it("throws a clear message when missing", () => {
    delete process.env.BETTER_AUTH_SECRET;
    expect(() => requireBetterAuthSecret()).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("throws when shorter than 32 characters", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "s".repeat(31));
    expect(() => requireBetterAuthSecret()).toThrow(/minimal 32 karakter/);
  });
});

describe("requireBetterAuthUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the value when set", () => {
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    expect(requireBetterAuthUrl()).toBe("http://localhost:3000");
  });

  it("throws a clear message when missing or not a URL", () => {
    delete process.env.BETTER_AUTH_URL;
    expect(() => requireBetterAuthUrl()).toThrow(/BETTER_AUTH_URL/);
    vi.stubEnv("BETTER_AUTH_URL", "bukan url");
    expect(() => requireBetterAuthUrl()).toThrow(/BETTER_AUTH_URL/);
  });
});

describe("requireDatabaseUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the value when set", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://postgres:pw@localhost:5432/postgres");
    expect(requireDatabaseUrl()).toBe("postgresql://postgres:pw@localhost:5432/postgres");
  });

  it("throws a clear message when missing", () => {
    delete process.env.DATABASE_URL;
    expect(() => requireDatabaseUrl()).toThrow(/DATABASE_URL/);
  });
});

describe("CRON_SECRET", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is read from the environment", () => {
    vi.stubEnv("CRON_SECRET", "x".repeat(40));
    expect(getEnv().CRON_SECRET).toBe("x".repeat(40));
  });

  it("is undefined when unset or empty", () => {
    vi.stubEnv("CRON_SECRET", "");
    expect(getEnv().CRON_SECRET).toBeUndefined();
  });
});

describe("createAppEnv with validation on", () => {
  const base = { DATABASE_URL: "postgresql://postgres:pw@localhost:5432/postgres" };

  it("throws when DATABASE_URL is missing", () => {
    expect(() =>
      createAppEnv({ skipValidation: false, isServer: true, runtimeEnv: {} }),
    ).toThrow(/Invalid environment variables/);
  });

  it("accepts a minimal valid environment", () => {
    const env = createAppEnv({ skipValidation: false, isServer: true, runtimeEnv: base });
    expect(env.DATABASE_URL).toBe(base.DATABASE_URL);
    expect(env.GROQ_API_KEY).toBeUndefined();
  });

  it("keeps the R2 variables optional and passes them through when set", () => {
    const bare = createAppEnv({
      skipValidation: false,
      isServer: true,
      runtimeEnv: base,
    });
    expect(bare.R2_ACCOUNT_ID).toBeUndefined();
    expect(bare.R2_APP_BUCKET).toBeUndefined();
    const set = createAppEnv({
      skipValidation: false,
      isServer: true,
      runtimeEnv: {
        ...base,
        R2_ACCOUNT_ID: "acct",
        R2_ACCESS_KEY_ID: "key",
        R2_SECRET_ACCESS_KEY: "secret",
        R2_APP_BUCKET: "bucket",
      },
    });
    expect(set.R2_ACCOUNT_ID).toBe("acct");
    expect(set.R2_ACCESS_KEY_ID).toBe("key");
    expect(set.R2_SECRET_ACCESS_KEY).toBe("secret");
    expect(set.R2_APP_BUCKET).toBe("bucket");
  });

  it("rejects a BETTER_AUTH_SECRET shorter than 32 characters", () => {
    expect(() =>
      createAppEnv({
        skipValidation: false,
        isServer: true,
        runtimeEnv: { ...base, BETTER_AUTH_SECRET: "short" },
      }),
    ).toThrow(/Invalid environment variables/);
  });

  it("rejects a CRON_SECRET of 31 characters and accepts one of 32", () => {
    expect(() =>
      createAppEnv({
        skipValidation: false,
        isServer: true,
        runtimeEnv: { ...base, CRON_SECRET: "c".repeat(31) },
      }),
    ).toThrow(/Invalid environment variables/);
    const env = createAppEnv({
      skipValidation: false,
      isServer: true,
      runtimeEnv: { ...base, CRON_SECRET: "c".repeat(32) },
    });
    expect(env.CRON_SECRET).toBe("c".repeat(32));
  });

  it("no longer declares JOBS_RUNNER_SECRET", () => {
    expect(ENV_KEYS).toContain("CRON_SECRET");
    expect(ENV_KEYS).not.toContain("JOBS_RUNNER_SECRET");
  });

  it("treats an empty variable as unset", () => {
    const env = createAppEnv({
      skipValidation: false,
      isServer: true,
      runtimeEnv: { ...base, GROQ_API_KEY: "" },
    });
    expect(env.GROQ_API_KEY).toBeUndefined();
  });

  it("throws when client code reads a server variable", () => {
    const env = createAppEnv({
      skipValidation: false,
      isServer: false,
      runtimeEnv: { ...base, GROQ_API_KEY: "gsk_secret" },
    });
    expect(() => env.GROQ_API_KEY).toThrow(
      /server-side environment variable on the client/,
    );
  });
});

describe("shouldSkipValidation", () => {
  it("skips under Vitest", () => {
    expect(shouldSkipValidation({ VITEST: "true" })).toBe(true);
    expect(shouldSkipValidation({ VITEST: "1" })).toBe(true);
    for (const value of ["false", "", "0", "yes"]) {
      expect(shouldSkipValidation({ VITEST: value }), `VITEST=${value}`).toBe(false);
    }
  });

  it("does not skip for SKIP_ENV_VALIDATION=1 outside a build or CI", () => {
    expect(shouldSkipValidation({ SKIP_ENV_VALIDATION: "1" })).toBe(false);
    expect(
      shouldSkipValidation({
        SKIP_ENV_VALIDATION: "1",
        NEXT_PHASE: "phase-production-server",
      }),
    ).toBe(false);
  });

  it("skips for SKIP_ENV_VALIDATION=1 in a build phase or on CI", () => {
    expect(
      shouldSkipValidation({
        SKIP_ENV_VALIDATION: "1",
        NEXT_PHASE: "phase-production-build",
      }),
    ).toBe(true);
    expect(shouldSkipValidation({ SKIP_ENV_VALIDATION: "1", CI: "true" })).toBe(true);
  });

  it("does not skip without the flag", () => {
    expect(
      shouldSkipValidation({ CI: "true", NEXT_PHASE: "phase-production-build" }),
    ).toBe(false);
  });
});

describe("assertBuildEnv", () => {
  it("throws in a production build when DATABASE_URL is missing", () => {
    vi.stubEnv("VITEST", "");
    // CI sets the flag for the whole job; this test is about the unskipped path.
    vi.stubEnv("SKIP_ENV_VALIDATION", "");
    vi.stubEnv("DATABASE_URL", "");
    expect(() => {
      assertBuildEnv("phase-production-build");
    }).toThrow(/Invalid environment variables/);
    vi.unstubAllEnvs();
  });

  it("does nothing outside a production build or when skipped", () => {
    expect(() => {
      assertBuildEnv("phase-development-server", {});
    }).not.toThrow();
    expect(() => {
      assertBuildEnv("phase-production-build", { SKIP_ENV_VALIDATION: "1", CI: "true" });
    }).not.toThrow();
  });
});
