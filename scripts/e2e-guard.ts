// Pure guard for every script that writes to a database for the CI-only e2e run. It must
// never touch staging or production, so it only passes for an explicit local host plus E2E_CI=1.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

export type E2eGuardEnv = Readonly<Record<string, string | undefined>>;

export function isLocalE2eDatabase(env: E2eGuardEnv): boolean {
  if (env.E2E_CI !== "1") return false;
  if (!env.DATABASE_URL) return false;
  let url: URL;
  try {
    url = new URL(env.DATABASE_URL);
  } catch {
    return false;
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return false;
  return LOCAL_HOSTS.has(url.hostname);
}

export function assertLocalE2eDatabase(env: E2eGuardEnv): void {
  if (!isLocalE2eDatabase(env)) {
    throw new Error(
      "Ditolak: skrip e2e hanya boleh berjalan bila E2E_CI=1 dan DATABASE_URL menunjuk ke localhost atau 127.0.0.1.",
    );
  }
}
