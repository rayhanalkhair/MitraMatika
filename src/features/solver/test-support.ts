// Test helpers for the solver: images made in the test (no binary fixture), a session seeder and a
// claimed job. Test-only.
import { createCanvas } from "@napi-rs/canvas";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import { solverSessions, solverSolutions } from "@/lib/db/schema";
import type { JobContext } from "@/lib/jobs/handler";
import { createJobQueue } from "@/lib/jobs/queue";
import type { ClaimedJob } from "@/lib/jobs/types";

type Db = PgAsyncDatabase<PgQueryResultHKT, AnyRelations>;

export function makePhoto(format: "png" | "jpeg", width = 16, height = 12): Uint8Array {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#111827";
  context.fillRect(0, 0, width, height);
  return new Uint8Array(
    format === "png" ? canvas.encodeSync("png") : canvas.encodeSync("jpeg"),
  );
}

export const htmlBytes = (): Uint8Array =>
  new TextEncoder().encode("<!doctype html><script>alert(1)</script>");

export async function seedSession(
  db: Db,
  input: {
    ownerId: string;
    status?: string;
    inputKind?: "text" | "photo" | "file";
    text?: string;
    inputKey?: string | null;
    extractedMd?: string | null;
    extractionFlags?: string[];
    confirmedMd?: string | null;
    createdAt?: Date;
    deletedAt?: Date | null;
  },
): Promise<string> {
  const kind = input.inputKind ?? "text";
  const [row] = await db
    .insert(solverSessions)
    .values({
      ownerId: input.ownerId,
      inputKind: kind,
      inputText: kind === "text" ? (input.text ?? "Hitung 1/2.") : null,
      inputKey: input.inputKey ?? null,
      extractedMd: input.extractedMd ?? null,
      extractionFlags: input.extractionFlags ?? [],
      confirmedMd:
        input.confirmedMd === undefined
          ? kind === "text"
            ? (input.text ?? "Hitung 1/2.")
            : null
          : input.confirmedMd,
      status: input.status ?? "ready",
      deletedAt: input.deletedAt ?? null,
      purgeAfter: input.deletedAt
        ? new Date(input.deletedAt.getTime() + 30 * 86_400_000)
        : null,
      ...(input.createdAt
        ? { createdAt: input.createdAt, updatedAt: input.createdAt }
        : {}),
    })
    .returning({ id: solverSessions.id });
  return row.id;
}

export async function seedSolution(
  db: Db,
  input: { ownerId: string; sessionId: string; method: string; isAlternative?: boolean },
): Promise<void> {
  await db.insert(solverSolutions).values({
    ownerId: input.ownerId,
    sessionId: input.sessionId,
    methodLabel: input.method,
    isAlternative: input.isAlternative ?? false,
    steps: [{ title: null, bodyMd: "Langkah." }],
    finalAnswer: { value: "1", unit: null, rounding: null },
    verificationStatus: "belum_dapat_diverifikasi",
  });
}

/** Enqueues one job and claims it (the only queued job). */
export async function claimJob(
  db: Db,
  input: { ownerId: string; type: string; payload: unknown; maxAttempts?: number },
): Promise<ClaimedJob> {
  const queue = createJobQueue(db);
  await queue.enqueue({ ...input, maxAttempts: input.maxAttempts ?? 3 });
  const job = await queue.claimNext();
  if (!job) throw new Error("no job");
  return job;
}

export const contextFor = (
  job: ClaimedJob,
  deadline = Date.now() + 240_000,
): JobContext => ({
  job,
  ownerId: job.ownerId,
  progress: null,
  correlationId: job.correlationId,
  deadline,
});
