import "server-only";
import type { MaterialKind } from "../schema/upload";
import { runBoundedWorker } from "./bounded-worker";

// Ruling R15: the parsing workers (pdf.worker.mjs, docx.worker.mjs) are copied unbundled, so the
// packages they import must be traced into every function that can claim an ingestion job
// (next.config.ts). Any function may start the job runner, though, and one without those files
// must not read a good file as damaged: ingestion asks first and waits for another function when
// a package cannot be loaded here.

/** The packages each kind's worker imports. */
export const INGEST_PACKAGES: Record<MaterialKind, readonly string[]> = {
  pdf: ["unpdf"],
  docx: ["jszip", "mammoth", "saxes"],
  image: [],
};

const PROBE_TIMEOUT_MS = 15_000;
// Packages this process has loaded once: they stay loadable for its lifetime.
const loadable = new Set<string>();

/**
 * Whether the worker for `kind` can load its packages in this function. Asks a probe worker
 * (started from the same folder as the parsing workers) once per process; a failed or crashed
 * probe means "not here".
 */
export async function ingestDependenciesAvailable(
  kind: MaterialKind,
  ownerId: string,
): Promise<boolean | "busy"> {
  const wanted = INGEST_PACKAGES[kind].filter((name) => !loadable.has(name));
  if (wanted.length === 0) return true;
  const result = await runBoundedWorker<{ missing?: unknown }>(
    new URL("./deps.worker.mjs", import.meta.url),
    {
      ownerId,
      // Only when the slot is free: a capability check never takes a waiting place from a real
      // parse (R31); a busy slot is "try again in 30 s".
      waitMs: 0,
      data: { packages: wanted },
      timeoutMs: PROBE_TIMEOUT_MS,
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
    },
  );
  // Another parse held the slot (R29): nothing was probed, which says nothing about the packages.
  if (!result.ok && result.reason === "busy") return "busy";
  if (!result.ok || !Array.isArray(result.value.missing)) return false;
  const missing: unknown[] = result.value.missing;
  for (const name of wanted) if (!missing.includes(name)) loadable.add(name);
  return missing.length === 0;
}
