import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_KEYS } from "./env";
import { createLogger, logger, sanitiseError, SECRET_ENV_KEYS } from "./logger";

// A made-up key used only to prove redaction. Built from parts at runtime so no literal in the source
// looks like a provider key to a secret scanner.
const FAKE_KEY = ["gsk", "live", "abcdef123456"].join("_");

beforeEach(() => {
  vi.stubEnv("LOG_LEVEL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { lines, log: createLogger(stream) };
}

describe("logger", () => {
  it("defaults to info and has the pino level methods", () => {
    expect(capture().log.level).toBe("info");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.warn).toBe("function");
  });

  it("binds a module through child()", () => {
    expect(logger.child({ module: "jobs" }).bindings()).toEqual({ module: "jobs" });
  });
});

describe("logger error serializers", () => {
  const url = "postgres://app_user:s3cretpw@db.example.com:5432/mitra";

  it("never emits a connection string or the DATABASE_URL value", () => {
    const dbUrl = "mysql-ish://internal-host/zzz-unique-token";
    vi.stubEnv("DATABASE_URL", dbUrl);
    const { lines, log } = capture();
    const error = Object.assign(new Error(`connect failed ${url} and ${dbUrl}`), {
      code: "28P01",
    });
    log.error({ err: error }, "boom");
    log.error({ error: `bad ${url}` }, "boom2");
    const out = lines.join("");
    expect(out).not.toContain("s3cretpw");
    expect(out).not.toContain("postgres://");
    expect(out).not.toContain("zzz-unique-token");
    expect(out).toContain("[redacted]");
    expect(out).toContain("28P01");
    expect(out).toContain("boom");
  });

  it("omits the message of a Drizzle query error (it carries SQL and parameters)", () => {
    const { lines, log } = capture();
    const failure = Object.assign(
      new Error('Failed query: insert ... params: "SECRET-NOTE"'),
      {
        name: "DrizzleQueryError",
        cause: Object.assign(new Error("x"), { code: "40001" }),
      },
    );
    log.error({ err: failure }, "boom");
    const out = lines.join("");
    expect(out).not.toContain("SECRET-NOTE");
    expect(out).toContain("40001");
  });
});

describe("structural query-error handling", () => {
  it("drops the message of a wrapped query error and never copies other properties", () => {
    const { lines, log } = capture();
    const lookalike = Object.assign(new Error("Failed query: select SECRET-SQL"), {
      query: "select SECRET-SQL",
      params: ["SECRET-PARAM"],
      parameters: ["SECRET-PARAM-2"],
      detail: "Key (email)=(SECRET-ROW) already exists",
      where: "SECRET-WHERE",
      hint: "SECRET-HINT",
      internalQuery: "SECRET-INTERNAL",
      internalPosition: "SECRET-POS",
    });
    log.error({ err: new Error("failed", { cause: lookalike }) }, "boom");
    const out = lines.join("");
    expect(out).not.toMatch(/SECRET|failed/);
    expect(JSON.parse(out) as { err: object }).toMatchObject({ err: { name: "Error" } });
    expect(Object.keys((JSON.parse(out) as { err: object }).err).sort()).toEqual([
      "name",
    ]);
  });

  it("emits name and code only for a pg-shaped error", () => {
    const { lines, log } = capture();
    const pg = Object.assign(new Error("password authentication failed for user x"), {
      code: "28P01",
      severity: "FATAL",
      detail: "Row (SECRET-VALUE)",
    });
    log.error({ err: pg }, "boom");
    const out = lines.join("");
    expect(out).not.toMatch(/SECRET-VALUE|password authentication/);
    expect(out).toContain("28P01");
  });

  it("keeps a redacted message for an ordinary error and strips credentials in any scheme", () => {
    vi.stubEnv("GROQ_API_KEY", FAKE_KEY);
    const { lines, log } = capture();
    log.error(
      {
        err: new Error(`fetch https://user:pass@host/path failed with key ${FAKE_KEY}`),
      },
      "boom",
    );
    const out = lines.join("");
    expect(out).not.toContain("user:pass");
    expect(out).not.toContain(FAKE_KEY);
    expect(out).toContain("[redacted]");
  });

  it("never throws, even when a property getter throws", () => {
    const hostile = {
      get message(): string {
        throw new Error("nope");
      },
    };
    expect(sanitiseError(hostile)).toEqual({ name: "Error" });
  });

  it.each(["name", "message", "cause", "code", "errors"])(
    "never throws when the %s getter throws",
    (field) => {
      const hostile = Object.defineProperty(new Error("x"), field, {
        get(): never {
          throw new Error("nope");
        },
      });
      expect(() => sanitiseError(hostile)).not.toThrow();
      expect(() => sanitiseError({ cause: hostile })).not.toThrow();
      expect(typeof (sanitiseError(hostile) as { name: unknown }).name).toBe("string");
    },
  );
});

describe("code and name shaping", () => {
  function emitted(error: unknown): { name: string; code?: string; message?: string } {
    const { lines, log } = capture();
    log.error({ err: error }, "boom");
    return (JSON.parse(lines.join("")) as { err: { name: string; code?: string } }).err;
  }

  it("emits a SQLSTATE or enum shaped code", () => {
    expect(emitted(Object.assign(new Error("x"), { code: "23505" })).code).toBe("23505");
    expect(emitted(Object.assign(new Error("x"), { code: "ECONNRESET" })).code).toBe(
      "ECONNRESET",
    );
  });

  it.each(["has space", "lower_case", "WAY_TOO_LONG_".repeat(5), "SELECT * FROM x;", ""])(
    "drops a code that is not enum shaped: %j",
    (code) => {
      expect(emitted(Object.assign(new Error("x"), { code }))).not.toHaveProperty("code");
    },
  );

  it("caps the name at 64 characters and redacts it", () => {
    const long = emitted(Object.assign(new Error("x"), { name: "N".repeat(200) }));
    expect(long.name.length).toBeLessThanOrEqual(64 + 3);
    vi.stubEnv("GROQ_API_KEY", FAKE_KEY);
    const leaky = emitted(Object.assign(new Error("x"), { name: `Err ${FAKE_KEY}` }));
    expect(leaky.name).not.toContain(FAKE_KEY);
  });
});

describe("chainHasQueryError", () => {
  function messageOf(error: unknown): string | undefined {
    return (sanitiseError(error) as { message?: string }).message;
  }

  it("keeps the message of a plain error", () => {
    expect(messageOf(new Error("plain"))).toBe("plain");
  });

  it("fails closed on a cause cycle", () => {
    const a = new Error("cycle-secret");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(messageOf(a)).toBeUndefined();
  });

  it("fails closed when the chain is deeper than the limit", () => {
    let error = new Error("deep-secret");
    for (let i = 0; i < 30; i += 1) error = new Error(`l${String(i)}`, { cause: error });
    expect(messageOf(error)).toBeUndefined();
  });

  it.each([
    "table_name",
    "schema_name",
    "constraint_name",
    "column_name",
    "hint",
    "details",
    "where",
    "internal_query",
  ])("detects the snake_case pg field %s", (field) => {
    const wrapped = new Error("outer-secret", {
      cause: Object.assign(new Error("inner"), { [field]: "v" }),
    });
    expect(messageOf(wrapped)).toBeUndefined();
  });

  it("walks AggregateError.errors", () => {
    const aggregate = new AggregateError(
      [new Error("fine"), Object.assign(new Error("x"), { query: "select 1" })],
      "aggregate-secret",
    );
    expect(messageOf(aggregate)).toBeUndefined();
    expect(messageOf(new AggregateError([new Error("a"), new Error("b")], "ok"))).toBe(
      "ok",
    );
  });
});

describe("secret scrubbing", () => {
  function emitMessage(message: string): string {
    const { lines, log } = capture();
    log.error({ err: new Error(message) }, "boom");
    return lines.join("");
  }

  it("scrubs a 4 character secret and its URL encoded forms", () => {
    vi.stubEnv("CRON_SECRET", "a b&");
    const out = emitMessage(
      `raw a b& enc ${encodeURIComponent("a b&")} uri ${encodeURI("a b&")}`,
    );
    expect(out).not.toContain("a b&");
    expect(out).not.toContain("a%20b%26");
    expect(out).not.toContain("a%20b&");
  });

  it("does not scrub a value shorter than 4 characters", () => {
    vi.stubEnv("CRON_SECRET", "abc");
    expect(emitMessage("keep abc here")).toContain("keep abc here");
  });

  it("scrubs the password component of DATABASE_URL, raw and percent decoded", () => {
    vi.stubEnv("DATABASE_URL", "mysql://u:p%40ss%2Fword@h/db");
    const out = emitMessage("failed with p%40ss%2Fword and p@ss/word here");
    expect(out).not.toContain("p%40ss%2Fword");
    expect(out).not.toContain("p@ss/word");
  });

  it("warns once per process about a short secret, naming only the variable", async () => {
    vi.resetModules();
    const fresh = await import("./logger");
    vi.stubEnv("RESEND_API_KEY", "short1");
    const warn = vi.fn();
    fresh.warnShortSecrets({ warn });
    fresh.warnShortSecrets({ warn });
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, text] = warn.mock.calls[0] as [object, string];
    expect(JSON.stringify([fields, text])).toContain("RESEND_API_KEY");
    expect(JSON.stringify([fields, text])).not.toContain("short1");
  });

  it("does not warn for a long enough secret", async () => {
    vi.resetModules();
    const fresh = await import("./logger");
    vi.stubEnv("RESEND_API_KEY", "long-enough-secret");
    const warn = vi.fn();
    fresh.warnShortSecrets({ warn });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("redaction guards", () => {
  it("scrubs scheme-less credentials", () => {
    const { lines, log } = capture();
    log.error({ err: new Error("bad host user:hunter22@db.internal:5432/x") }, "boom");
    expect(lines.join("")).not.toContain("hunter22");
  });

  it("handles a 100 KB adversarial string quickly without throwing", () => {
    for (const unit of ["a://b:", "a:", "postgres://", "a:b:c:", "@:"]) {
      const hostile = unit.repeat(Math.ceil(100_000 / unit.length));
      const started = performance.now();
      expect(() => sanitiseError(new Error(hostile))).not.toThrow();
      expect(() => sanitiseError(hostile)).not.toThrow();
      expect(performance.now() - started).toBeLessThan(100);
    }
  });

  it("scans only the first 4096 characters of the input", () => {
    const out = sanitiseError(`${"x".repeat(5000)} user:pw@host`) as string;
    expect(out.length).toBeLessThanOrEqual(503);
  });
});

describe("pino redact paths", () => {
  it("censors sensitive object paths", () => {
    const { lines, log } = capture();
    log.info(
      {
        req: { headers: { authorization: "Bearer x", cookie: "c=1" } },
        user: { token: "t" },
      },
      "req",
    );
    const out = lines.join("");
    expect(out).not.toMatch(/Bearer x|c=1|"t"/);
    expect(out).toContain("[redacted]");
  });

  it.each([
    "password",
    "token",
    "apiKey",
    "secret",
    "accessToken",
    "refreshToken",
    "authorization",
    "cookie",
  ])("censors %s at the top level, one level and two levels deep, not three", (key) => {
    const { lines, log } = capture();
    log.info(
      {
        [key]: "LEAK-0",
        one: { [key]: "LEAK-1" },
        two: { inner: { [key]: "LEAK-2" } },
        three: { a: { b: { [key]: "LEAK-3" } } },
      },
      "x",
    );
    const out = lines.join("");
    expect(out).not.toMatch(/LEAK-[012]/);
    // pino has no recursive wildcard: three levels deep is knowingly not covered.
    expect(out).toContain("LEAK-3");
  });
});

describe("SECRET_ENV_KEYS", () => {
  it("lists every declared env key that looks like a secret", () => {
    const secretLike = ENV_KEYS.filter((key) =>
      /_(SECRET|API_KEY|ACCESS_KEY|ACCESS_KEY_ID|SECRET_ACCESS_KEY|TOKEN|PASSWORD|CREDENTIALS?)$/.test(
        key,
      ),
    );
    const missing = secretLike.filter((key) => !SECRET_ENV_KEYS.includes(key));
    expect(missing).toEqual([]);
  });
});

describe("SECRET_ENV_KEYS CRON_SECRET", () => {
  it("logger redacts CRON_SECRET", () => {
    expect(SECRET_ENV_KEYS).toContain("CRON_SECRET");
    expect(SECRET_ENV_KEYS).not.toContain("JOBS_RUNNER_SECRET");
  });
});

describe("SECRET_ENV_KEYS R2 credentials", () => {
  it("covers both R2 credential variables", () => {
    expect(ENV_KEYS).toContain("R2_SECRET_ACCESS_KEY");
    expect(SECRET_ENV_KEYS).toContain("R2_SECRET_ACCESS_KEY");
    expect(SECRET_ENV_KEYS).toContain("R2_ACCESS_KEY_ID");
  });
});
