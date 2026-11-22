import { err, ok, type Result } from "@/lib/result";
import type { Counts, WriteSeedResult } from "./seed-writer";

export const DEFAULT_SEED_FILE = "data/curriculum/grade-8-v1.json";

export type SeedArgs = Result<{ file: string; activate: boolean; dryRun: boolean }>;

const USAGE =
  "Pemakaian: pnpm db:seed:curriculum [--file <jalur>] [--activate] [--dry-run]";

export function parseSeedArgs(argv: readonly string[]): SeedArgs {
  let file = DEFAULT_SEED_FILE;
  let activate = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--activate") {
      activate = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--file") {
      const value = argv.at(i + 1);
      if (value === undefined || value.startsWith("--")) {
        return err(`--file membutuhkan jalur berkas. ${USAGE}`);
      }
      file = value;
      i += 1;
    } else if (arg.startsWith("--")) {
      return err(`Opsi tidak dikenal: ${arg}. ${USAGE}`);
    } else {
      return err(`Argumen tidak dikenal: ${arg}. ${USAGE}`);
    }
  }

  if (activate && dryRun) {
    return err(`--activate tidak dapat dipakai bersama --dry-run. ${USAGE}`);
  }
  return ok({ file, activate, dryRun });
}

// Host and database name only: never the username or password.
export function describeTarget(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    const database = url.pathname.replace(/^\//, "") || "(tanpa nama)";
    return `${url.hostname}/${database}`;
  } catch {
    return "(URL database tidak dapat dibaca)";
  }
}

function describeCounts(counts: Counts): string {
  return `${String(counts.versions)} versi, ${String(counts.elements)} elemen, ${String(counts.topics)} topik, ${String(counts.objectives)} tujuan pembelajaran`;
}

const total = (c: Counts) => c.versions + c.elements + c.topics + c.objectives;

export function formatResult(
  result: WriteSeedResult,
  options: { dryRun: boolean },
): string[] {
  const lines: string[] = [];
  if (options.dryRun) {
    lines.push("UJI COBA (--dry-run): tidak ada yang ditulis ke database.");
  }
  lines.push(`Versi kurikulum: ${result.versionCode} (status: ${result.versionStatus})`);
  if (result.unchanged) {
    lines.push("Tidak ada perubahan: isi database sudah sama dengan berkas seed.");
  } else {
    if (total(result.created) > 0)
      lines.push(`Ditambahkan: ${describeCounts(result.created)}`);
    if (total(result.updated) > 0)
      lines.push(`Diperbarui: ${describeCounts(result.updated)}`);
    if (total(result.deleted) > 0)
      lines.push(`Dihapus: ${describeCounts(result.deleted)}`);
  }
  if (result.activated) lines.push("Versi ini sekarang AKTIF dan dipakai aplikasi.");
  if (result.archivedVersions.length > 0) {
    lines.push(`Versi yang diarsipkan: ${result.archivedVersions.join(", ")}`);
  }
  if (!result.activated && result.versionStatus === "draft") {
    lines.push(
      "Versi masih draf: jalankan lagi dengan --activate setelah validasi (P0-12).",
    );
  }
  return lines;
}
