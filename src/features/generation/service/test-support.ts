import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { generationRequests, jobs } from "@/lib/db/schema";
import type { TestDatabase } from "@/lib/db/test-harness";
import type { JobContext } from "@/lib/jobs/handler";
import type { ClaimedJob } from "@/lib/jobs/types";
import { createCurriculumRepository } from "@/features/curriculum";
import type { CurriculumSeed } from "@/features/curriculum";
import { writeSeed } from "@/features/curriculum";

export { batchJson, questionJson, solverJson } from "./fixtures";

// A scripted solver answer that picks the option holding the right answer, wherever the shuffle put
// it (saved options are shuffled per request). For a prompt that is not a fixture question it
// answers `machine`, labelled `label` if no option has that text.
export function solverPicking(label: string, machine: string) {
  return (_system: string, prompt: string): string => {
    // The fixture question n asks "Hitung $n + n$": its answer is read from the prompt, so the
    // scripted order of solver replies does not have to match the order questions are verified in.
    const asked = /Hitung \$(\d+) \+ \1\$/.exec(prompt);
    const solved = asked ? String(2 * Number(asked[1])) : machine;
    const hit = prompt
      .split("\n")
      .map((line) => /^([A-D])\. (.*)$/.exec(line))
      .find((m) => m?.[2] === solved);
    return JSON.stringify({
      correctLabel: hit ? hit[1] : label,
      answer: { display_md: solved, machine: solved },
      steps: ["Selesaikan soalnya."],
    });
  };
}

// A scripted solver that genuinely disagrees: for a fixture question it picks the distractor
// 2n + 1 (and answers that value), wherever the shuffle put it. A saved key that pointed at the
// wrong option would not be caught by solverPicking; this one makes the cross-check fail.
export function solverWrong() {
  return (_system: string, prompt: string): string => {
    const asked = /Hitung \$(\d+) \+ \1\$/.exec(prompt);
    const wrong = String(2 * Number(asked?.[1] ?? 0) + 1);
    const hit = prompt
      .split("\n")
      .map((line) => /^([A-D])\. (.*)$/.exec(line))
      .find((m) => m?.[2] === wrong);
    return JSON.stringify({
      correctLabel: hit ? hit[1] : "A",
      answer: { display_md: wrong, machine: wrong },
      steps: ["Selesaikan soalnya."],
    });
  };
}

type Db = TestDatabase["db"];

export function makeSeed(code: string): CurriculumSeed {
  return {
    version: {
      code,
      title: `Versi ${code}`,
      sourceTitle: "Sumber",
      sourceUrl: "https://example.test/s",
      decreeRef: "SK 1/2025",
      publishedOn: "2025-07-16",
      retrievedOn: "2026-09-23",
    },
    elements: [{ code: "aljabar", name: "Aljabar", outcomeText: "CP aljabar" }],
    topics: [
      {
        stableKey: "spldv",
        grade: 8,
        elementCode: "aljabar",
        title: "SPLDV",
        scopeNotes: "Catatan spldv",
        sourceRef: "ref-2",
        sortOrder: 1,
        objectives: [{ code: "TP-3", text: "Tiga", sourceRef: "r3" }],
      },
    ],
  };
}

// Loads and activates a curriculum version and returns the ids a request needs.
export async function seedCurriculum(db: Db, code = "v1") {
  await writeSeed(db, makeSeed(code), { activate: true });
  const topic = await createCurriculumRepository(db).getTopic({
    grade: 8,
    stableKey: "spldv",
  });
  if (!topic) throw new Error("seed topic missing");
  return {
    versionId: topic.version.id,
    topicId: topic.id,
    topicStableKey: topic.stableKey,
    sourceRef: topic.sourceRef,
  };
}

export interface SeedRequestInput {
  ownerId: string;
  versionId: string;
  topicId: string;
  quantity?: number;
  difficulty?: "mudah" | "sedang" | "sulit";
  status?: string;
  params?: unknown;
}

// A request plus its running job, linked the way createGenerationRequest links them.
export async function seedGenerationRequest(db: Db, input: SeedRequestInput) {
  const [request] = await db
    .insert(generationRequests)
    .values({
      ownerId: input.ownerId,
      status: input.status ?? "queued",
      params: input.params ?? {
        grade: 8,
        topicId: input.topicId,
        topicStableKey: "spldv",
        topicTitle: "SPLDV",
        curriculumVersionId: input.versionId,
        type: "multiple_choice",
        quantity: input.quantity ?? 5,
        difficulty: input.difficulty ?? "sedang",
      },
    })
    .returning({ id: generationRequests.id });
  const [job] = await db
    .insert(jobs)
    .values({
      ownerId: input.ownerId,
      type: "generate_batch",
      payload: { requestId: request.id },
      status: "running",
    })
    .returning({ id: jobs.id });
  await db
    .update(generationRequests)
    .set({ jobId: job.id })
    .where(eq(generationRequests.id, request.id));
  return { requestId: request.id, jobId: job.id };
}

export async function buildContext(
  db: Db,
  jobId: string,
  options: {
    now: Date;
    remainingMs?: number;
    attempts?: number;
    maxAttempts?: number;
    ownerId?: string;
  },
): Promise<JobContext> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  const job: ClaimedJob = {
    ...row,
    lockToken: randomUUID(),
    attempts: options.attempts ?? row.attempts,
    maxAttempts: options.maxAttempts ?? row.maxAttempts,
    ownerId: options.ownerId ?? row.ownerId,
  };
  return {
    job,
    ownerId: job.ownerId,
    progress: null,
    correlationId: job.correlationId,
    deadline: options.now.getTime() + (options.remainingMs ?? 240_000),
  };
}
