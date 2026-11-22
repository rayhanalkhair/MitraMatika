import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

type RuntimeEnv = Record<string, string | undefined>;

interface CreateAppEnvOptions {
  /** Defaults to on under Vitest or when SKIP_ENV_VALIDATION=1. */
  skipValidation?: boolean;
  /** Replaces process.env as the source. Tests only. */
  runtimeEnv?: RuntimeEnv;
  /** Forces the server/client decision. Tests only. */
  isServer?: boolean;
}

/**
 * SKIP_ENV_VALIDATION=1 is honoured only while building or on CI, never on a running server,
 * where it would silently turn validation off (fail open).
 */
export function shouldSkipValidation(source: RuntimeEnv = process.env): boolean {
  if (source.VITEST === "true" || source.VITEST === "1") return true;
  return (
    source.SKIP_ENV_VALIDATION === "1" &&
    (source.NEXT_PHASE === "phase-production-build" || source.CI === "true")
  );
}

const serverSchema = {
  GROQ_API_KEY: z.string().min(1).optional(),
  GOOGLE_API_KEY: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  BETTER_AUTH_URL: z.url().optional(),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(1).optional(),
  // Vercel Cron sends it as `Authorization: Bearer $CRON_SECRET` to /api/jobs/run.
  CRON_SECRET: z.string().min(32).optional(),
  // Object storage (Cloudflare R2). Optional so a deploy without files still boots; the storage
  // module throws on first use in production when any of the four is missing.
  R2_ACCOUNT_ID: z.string().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_APP_BUCKET: z.string().min(1).optional(),
  // Access gate (ADR-0022): comma-separated approved addresses, and the always-approved admin who
  // also receives the notices. Read lazily through getEnv() on every request, never at import.
  ALLOWED_EMAILS: z.string().min(1).optional(),
  ADMIN_EMAIL: z.string().min(1).optional(),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .optional(),
};
// No client variables: the browser only talks to this app's own origin.
const clientSchema = {};

export type Env = z.infer<z.ZodObject<typeof serverSchema>> &
  z.infer<z.ZodObject<typeof clientSchema>>;

export const ENV_KEYS = [
  ...Object.keys(serverSchema),
  ...Object.keys(clientSchema),
] as (keyof Env)[];

// Only the declared keys are read. A future client variable must be written out literally here,
// because Next inlines `process.env.NEXT_PUBLIC_*` only when it sees the exact expression.
function readRuntimeEnv(
  source: RuntimeEnv = process.env,
): Record<keyof Env, string | undefined> {
  const out = {} as Record<keyof Env, string | undefined>;
  for (const key of ENV_KEYS) out[key] = source[key];
  return out;
}

/**
 * The strict, validated environment (t3-env). DATABASE_URL is required here; every other
 * variable is optional and the require*() helpers below throw lazily with an Indonesian
 * message only when a value is actually needed.
 */
export function createAppEnv(options: CreateAppEnvOptions = {}): Env {
  // With a runtime skipValidation flag t3 types the result as an open record; the schema above
  // is the real shape whenever validation runs, so state it here.
  return createEnv({
    server: serverSchema,
    client: clientSchema,
    runtimeEnv: readRuntimeEnv(options.runtimeEnv),
    ...(options.isServer === undefined ? {} : { isServer: options.isServer }),
    skipValidation: options.skipValidation ?? shouldSkipValidation(),
    // An empty variable (`KEY=`) counts as unset.
    emptyStringAsUndefined: true,
  }) as unknown as Env;
}

let validated: Env | undefined;

/**
 * Validates on first access, not on import, so a missing DATABASE_URL cannot take down modules
 * that merely import this file (the proxy, the health route, the logger). Fail-closed callers
 * read through getEnv() instead.
 */
export const env: Env = new Proxy({} as Env, {
  get(_target, prop) {
    validated ??= createAppEnv();
    return Reflect.get(validated, prop) as unknown;
  },
});

/**
 * Build-time gate: next.config.ts calls this with the phase Next passes to the config function,
 * so `next build` fails on a bad environment. A no-op outside a production build or when
 * validation is skipped. (process.env.NEXT_PHASE is only set after the config has loaded.)
 */
export function assertBuildEnv(phase: string, source: RuntimeEnv = process.env): void {
  if (phase !== "phase-production-build") return;
  if (shouldSkipValidation({ ...source, NEXT_PHASE: phase })) return;
  createAppEnv();
}

/**
 * Lenient read for runtime callers: never throws, never validates. Each require*() reports its
 * own missing variable (in Indonesian), and callers like the proxy and jobs auth apply their own
 * checks, so one missing or malformed variable cannot break an unrelated path. Re-reads
 * process.env on every call.
 */
export function getEnv(): Partial<Env> {
  const out: Partial<Record<keyof Env, string>> = {};
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined && value !== "") out[key] = value;
  }
  return out as Partial<Env>;
}

export function requireGroqApiKey(): string {
  const key = getEnv().GROQ_API_KEY;
  if (!key) {
    throw new Error(
      "GROQ_API_KEY tidak ditemukan. Salin .env.example ke .env.local dan isi kuncimu sendiri.",
    );
  }
  return key;
}

export function requireGoogleApiKey(): string {
  const key = getEnv().GOOGLE_API_KEY;
  if (!key) {
    throw new Error(
      "GOOGLE_API_KEY tidak ditemukan. Salin .env.example ke .env.local dan isi kuncimu sendiri.",
    );
  }
  return key;
}

export const MIN_AUTH_SECRET_LENGTH = 32;

export function requireBetterAuthSecret(): string {
  const value = getEnv().BETTER_AUTH_SECRET;
  if (!value || value.length < MIN_AUTH_SECRET_LENGTH) {
    throw new Error(
      "BETTER_AUTH_SECRET tidak ditemukan atau terlalu pendek (minimal 32 karakter). Salin .env.example ke .env.local dan isi dengan string acak, misalnya hasil `openssl rand -hex 32`.",
    );
  }
  return value;
}

export function requireBetterAuthUrl(): string {
  const value = getEnv().BETTER_AUTH_URL;
  if (!value || !URL.canParse(value)) {
    throw new Error(
      "BETTER_AUTH_URL tidak ditemukan atau bukan URL yang valid. Salin .env.example ke .env.local dan isi dengan origin aplikasi, misalnya http://localhost:3000.",
    );
  }
  return value;
}

export function requireDatabaseUrl(): string {
  const value = getEnv().DATABASE_URL;
  if (!value) {
    throw new Error(
      "DATABASE_URL tidak ditemukan. Salin .env.example ke .env.local dan isi dengan connection string Postgres (pooled connection string untuk Vercel).",
    );
  }
  return value;
}
