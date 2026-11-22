import { eq } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import { user } from "./tables/auth";

export interface Check {
  name: string;
  run: () => Promise<void>;
}
export interface CheckResult {
  name: string;
  ok: boolean;
  error?: string;
}

export function requireStagingConfirmation(argv: readonly string[], userCount = 2): void {
  if (!argv.includes("--confirm-staging")) {
    throw new Error(
      `Uji ini membuat ${userCount === 1 ? "satu" : userCount === 2 ? "dua" : String(userCount)} pengguna sementara di basis data yang aktif di .env.local. Tambahkan --confirm-staging untuk melanjutkan, dan pastikan basis data itu adalah STAGING.`,
    );
  }
}

// A short, printable label for the target (the first DNS label of its host), so the operator
// can see which project a staging run is about to touch.
export function projectRefFromUrl(url: string): string {
  // The URL carries the database password, so no error here may include it (or the URL itself).
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("URL basis data tidak valid (periksa DATABASE_URL).");
  }
  const label = host.split(".")[0];
  if (!label) {
    throw new Error(`URL basis data tidak dikenali (tidak ada nama host).`);
  }
  return label;
}

// A denied read shows up either as an error (no privilege) or as an empty result (RLS filter).
export function isNoAccess(result: { data: unknown; error: unknown }): boolean {
  if (result.error) return true;
  return Array.isArray(result.data) ? result.data.length === 0 : result.data == null;
}

// A privilege denial (no grant, or an RLS WITH CHECK violation) is SQLSTATE 42501, carried as
// `code`. Anything else (wrong table, schema cache, network) is NOT a denial and must not be
// accepted as one.
export function isPermissionDenied(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "42501"
  );
}

export function describeError(error: unknown): string {
  if (typeof error !== "object" || error === null) return "tidak ada error";
  const { code, message } = error as { code?: unknown; message?: unknown };
  const text =
    typeof message === "string"
      ? message
      : message === undefined || message === null
        ? ""
        : JSON.stringify(message);
  return typeof code === "string" && code ? `${code}: ${text}` : text;
}

// Only a missing table means "not migrated"; a bad DATABASE_URL or a network error must not be
// reported as a migration problem.
// Drizzle wraps the driver error, so the original code can sit on `cause`.
function looksUnmigrated(error: unknown, depth = 0): boolean {
  if (typeof error !== "object" || error === null || depth > 3) return false;
  const { code, message, cause } = error as {
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  if (code === "42P01" || code === "PGRST205") return true;
  const text = typeof message === "string" ? message : "";
  if (text.includes("PGRST205") || text.includes("does not exist")) return true;
  return looksUnmigrated(cause, depth + 1);
}

export function preflightMessage(error: unknown): string {
  if (looksUnmigrated(error)) {
    return `Migrasi belum diterapkan di proyek ini: jalankan pnpm db:migrate dulu. (${describeError(error)})`;
  }
  return `Pemeriksaan awal gagal (periksa DATABASE_URL dan koneksi): ${describeError(error)}`;
}

export function cleanupHint(stamp: number): string {
  return `Jika ada pengguna sementara yang tersisa, hapus secara manual dari tabel "user": rls-a-${String(stamp)}@example.test dan rls-b-${String(stamp)}@example.test.`;
}

export async function runChecks(checks: Check[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    try {
      await check.run();
      results.push({ name: check.name, ok: true });
    } catch (error) {
      results.push({
        name: check.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

export function summarize(results: CheckResult[]): { passed: number; failed: number } {
  const passed = results.filter((r) => r.ok).length;
  return { passed, failed: results.length - passed };
}

// The staging scripts' throwaway teachers are plain "user" rows written over DATABASE_URL (the
// table owner), the shape Better Auth itself writes. Deleting the row cascades through the
// profile to everything the user owns.
export async function createThrowawayUser<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(db: PgAsyncDatabase<TQueryResult, TRelations>, email: string): Promise<string> {
  const rows = await db
    .insert(user)
    .values({ name: "Pengguna uji sementara", email, emailVerified: true })
    .returning({ id: user.id });
  const row = rows.at(0);
  if (!row) throw new Error(`Gagal membuat pengguna sementara ${email}`);
  return row.id;
}

export async function deleteThrowawayUser<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(db: PgAsyncDatabase<TQueryResult, TRelations>, userId: string): Promise<void> {
  await db.delete(user).where(eq(user.id, userId));
}
