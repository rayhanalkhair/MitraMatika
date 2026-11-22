// Fixtures for the assessment and template trash tests: a listing memory store whose deletes can be
// made to fail, export runs with their stored files, and a clean slate between tests.
import { auditLog, deletionLog, exports, jobs } from "@/lib/db/schema";
import type { TestDatabase } from "@/lib/db/test-harness";
import { createMemoryStore } from "@/lib/storage/memory";
import type { ObjectStore } from "@/lib/storage/types";
import { clearAll } from "@/features/assessments/test-support";

/** The memory store plus a listing of its keys; deletes under `failPrefix` throw. */
export function listingStore(
  options: { failPrefix?: (prefix: string) => boolean } = {},
): ObjectStore & { keys: () => string[]; deletedPrefixes: string[] } {
  const inner = createMemoryStore();
  const keys = new Set<string>();
  const deletedPrefixes: string[] = [];
  return {
    keys: () => [...keys].sort(),
    deletedPrefixes,
    async put(key, body, contentType) {
      await inner.put(key, body, contentType);
      keys.add(key);
    },
    get: (key) => inner.get(key),
    async delete(key) {
      if (options.failPrefix?.(key)) throw new Error("storage unavailable");
      await inner.delete(key);
      keys.delete(key);
    },
    async deletePrefix(prefix) {
      if (options.failPrefix?.(prefix)) throw new Error("storage unavailable");
      deletedPrefixes.push(prefix);
      const count = await inner.deletePrefix(prefix);
      for (const key of [...keys]) if (key.startsWith(prefix)) keys.delete(key);
      return count;
    },
    signedGetUrl: (key, seconds, signed) => inner.signedGetUrl(key, seconds, signed),
    signedPutUrl: (key, type, length, seconds) =>
      inner.signedPutUrl(key, type, length, seconds),
  };
}

/**
 * One export run of the assessment: a render_export job and, when `rows` is set, a PDF and a ZIP
 * row with their stored files (a failed run leaves files but no rows). Returns the job id.
 */
export async function seedExportRun(
  database: TestDatabase,
  store: ObjectStore,
  input: {
    ownerId: string;
    assessmentId: string;
    hash: string;
    rows?: boolean;
    status?: string;
  },
): Promise<string> {
  const { ownerId, assessmentId } = input;
  const [job] = await database.db
    .insert(jobs)
    .values({
      ownerId,
      type: "render_export",
      payload: { assessmentId, snapshotHash: input.hash },
      status: input.status ?? "succeeded",
    })
    .returning({ id: jobs.id });
  const files = [
    { document: "paper", format: "pdf", name: "paper.pdf" },
    { document: "zip", format: "zip", name: "bundle.zip" },
  ];
  for (const file of files) {
    const objectKey = `exports/${ownerId}/${job.id}/${file.name}`;
    await store.put(objectKey, new Uint8Array([1, 2, 3]), "application/octet-stream");
    if (input.rows === false) continue;
    await database.db.insert(exports).values({
      ownerId,
      assessmentId,
      document: file.document,
      format: file.format,
      objectKey,
      snapshotHash: input.hash,
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      jobId: job.id,
    });
  }
  return job.id;
}

/** Everything the trash tests fill, children first. */
export async function clearTrashTables(database: TestDatabase): Promise<void> {
  await database.db.delete(deletionLog);
  await database.db.delete(auditLog);
  await clearAll(database);
}
