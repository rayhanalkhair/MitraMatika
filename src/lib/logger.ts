import "server-only";
import { DrizzleQueryError } from "drizzle-orm";
import pino, { type DestinationStream } from "pino";
import { getEnv } from "@/lib/env";

const LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
const MAX_MESSAGE = 500;
const MIN_SECRET_LENGTH = 4;
const MAX_CAUSE_DEPTH = 10;
const MAX_CHAIN_NODES = 50;
const MAX_SCAN = 4096;
const MAX_NAME = 64;
const REDACTED = "[redacted]";

// Every env var that holds a secret. Values are read from process.env at log time and scrubbed
// from logged error text. Keep in step with the env schema: logger.test.ts fails when a key that is
// credential-shaped (*_SECRET, *_API_KEY, *_ACCESS_KEY[_ID], *_TOKEN, *_PASSWORD, *_CREDENTIAL[S]) is
// declared there but missing here. R2_ACCOUNT_ID is left out on purpose: it is an account
// identifier that appears in the public endpoint hostname, not a credential.
export const SECRET_ENV_KEYS: readonly string[] = [
  "GROQ_API_KEY",
  "GOOGLE_API_KEY",
  "DATABASE_URL",
  "CRON_SECRET",
  "BETTER_AUTH_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "RESEND_API_KEY",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
];

// postgres(ql):// anything, and credentials (user:pass@) in any scheme, scheme optional. Every
// quantifier is bounded and the input is sliced first (MAX_SCAN), so a hostile string cannot
// trigger catastrophic backtracking.
const CONNECTION_STRING = /postgres(?:ql)?:\/\/\S{1,512}/gi;
const CREDENTIAL_URL = /[^\s/@:]{1,64}:[^\s@]{1,256}@[^\s]{1,512}/g;

const WARN_BELOW = 8;
let shortSecretWarned = false;

function variantsOf(value: string): string[] {
  const out = new Set([value]);
  try {
    out.add(encodeURIComponent(value));
    out.add(encodeURI(value));
  } catch {
    // A lone surrogate makes the encoders throw; the raw value is still scrubbed.
  }
  return [...out];
}

function passwordsOfUrl(value: string): string[] {
  try {
    const { password } = new URL(value);
    if (!password) return [];
    let decoded = password;
    try {
      decoded = decodeURIComponent(password);
    } catch {
      // Keep the raw component.
    }
    return [password, decoded].filter((part) => part.length >= MIN_SECRET_LENGTH);
  } catch {
    return [];
  }
}

function redact(text: string, max = MAX_MESSAGE): string {
  let out = text
    .slice(0, MAX_SCAN)
    .replace(CONNECTION_STRING, REDACTED)
    .replace(CREDENTIAL_URL, REDACTED);
  for (const key of SECRET_ENV_KEYS) {
    const value = process.env[key];
    if (!value) continue;
    const needles =
      key === "DATABASE_URL" ? [...passwordsOfUrl(value), ...variantsOf(value)] : [];
    if (value.length >= MIN_SECRET_LENGTH) needles.push(...variantsOf(value));
    for (const needle of needles) {
      if (needle.length >= MIN_SECRET_LENGTH) out = out.split(needle).join(REDACTED);
    }
  }
  return out.length > max ? `${out.slice(0, max)}...` : out;
}

/**
 * Logs ONE warning per process, naming only the variable NAMES, when a declared secret is set
 * but shorter than 8 characters (it is still scrubbed from 4 characters up, but a short secret
 * is weak). Never logs a value.
 */
export function warnShortSecrets(log: { warn: (obj: object, msg: string) => void }) {
  if (shortSecretWarned) return;
  const names = SECRET_ENV_KEYS.filter((key) => {
    const value = process.env[key];
    return value !== undefined && value !== "" && value.length < WARN_BELOW;
  });
  if (names.length === 0) return;
  shortSecretWarned = true;
  log.warn(
    { module: "logger", variables: names },
    "declared secret is shorter than 8 characters",
  );
}

const CODE_SHAPE = /^[A-Z0-9_]{1,32}$/;

const REDACT_KEYS = [
  "password",
  "token",
  "apiKey",
  "secret",
  "accessToken",
  "refreshToken",
  "authorization",
  "cookie",
] as const;

function codeOf(value: unknown): string | undefined {
  const code = (value as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

const PG_FIELDS = [
  "routine",
  "schema",
  "table",
  "constraint",
  "table_name",
  "schema_name",
  "constraint_name",
  "column_name",
  "hint",
  "detail",
  "details",
  "where",
  "internal_query",
] as const;

// A query or driver error carries SQL, parameters or row values in its message or fields.
function isQueryError(link: object): boolean {
  if (link instanceof DrizzleQueryError) return true;
  const o = link as Record<string, unknown>;
  const ctor = (link as { constructor?: { name?: unknown } }).constructor?.name;
  if (ctor === "DrizzleQueryError" || o.name === "DrizzleQueryError") return true;
  if ("query" in o || "params" in o || "parameters" in o) return true;
  if (typeof o.severity === "string" && typeof o.code === "string") return true;
  return PG_FIELDS.some((field) => field in o);
}

// Walks `cause` and AggregateError.errors. Fails closed: a cycle, a chain deeper than
// MAX_CAUSE_DEPTH or more than MAX_CHAIN_NODES links counts as a query error (no message).
function chainHasQueryError(top: unknown): boolean {
  const seen = new Set<unknown>();
  const stack: { link: unknown; depth: number }[] = [{ link: top, depth: 0 }];
  while (stack.length > 0) {
    const { link, depth } = stack.pop() as { link: unknown; depth: number };
    if (link === null || typeof link !== "object") continue;
    if (depth >= MAX_CAUSE_DEPTH || seen.has(link) || seen.size >= MAX_CHAIN_NODES) {
      return true;
    }
    if (isQueryError(link)) return true;
    seen.add(link);
    stack.push({ link: (link as { cause?: unknown }).cause, depth: depth + 1 });
    const errors = (link as { errors?: unknown }).errors;
    if (Array.isArray(errors)) {
      for (const inner of errors) stack.push({ link: inner, depth: depth + 1 });
    }
  }
  return false;
}

function firstCode(top: unknown): string | undefined {
  const seen = new Set<unknown>();
  let link: unknown = top;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (link === null || typeof link !== "object" || seen.has(link)) return undefined;
    const code = codeOf(link);
    if (code !== undefined) return CODE_SHAPE.test(code) ? code : undefined;
    seen.add(link);
    link = (link as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Only a fixed set of fields is ever emitted (name, code, message) and never arbitrary own
 * properties. The message is dropped when ANY link of the cause chain is a query or driver
 * error. Never throws: a hostile getter must not break logging.
 */
export function sanitiseError(value: unknown): unknown {
  try {
    if (typeof value === "string") return redact(value);
    if (value === null || typeof value !== "object") return value;
    const { name, message } = value as { name?: unknown; message?: unknown };
    const out: Record<string, string> = {
      name: typeof name === "string" ? redact(name, MAX_NAME) : "Error",
    };
    const code = firstCode(value);
    if (code) out.code = code;
    if (typeof message === "string" && !chainHasQueryError(value)) {
      out.message = redact(message);
    }
    return out;
  } catch {
    return { name: "Error" };
  }
}

/**
 * JSON lines to stdout only. No transport option: transports run in a worker thread, which does
 * not survive serverless bundling. Pretty-print locally by piping: `pnpm dev | pino-pretty`.
 */
export function createLogger(destination?: DestinationStream) {
  const requested = getEnv().LOG_LEVEL;
  const options = {
    level: requested && LEVELS.has(requested) ? requested : "info",
    serializers: { err: sanitiseError, error: sanitiseError },
    redact: {
      // pino has no recursive wildcard: only the top level, one level (`*.x`) and two levels
      // (`*.*.x`) are covered. Deeper nesting is NOT redacted, so call sites must never log
      // raw objects (log picked, named fields instead).
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        ...REDACT_KEYS,
        ...REDACT_KEYS.map((key) => `*.${key}`),
        ...REDACT_KEYS.map((key) => `*.*.${key}`),
      ],
      censor: REDACTED,
    },
  };
  return destination ? pino(options, destination) : pino(options);
}

/**
 * Call sites pass `{ module: "name", ... }` as the first argument rather than holding a
 * `logger.child({ module })`, so tests can spy on this one shared instance.
 */
export const logger = createLogger();
warnShortSecrets(logger);
