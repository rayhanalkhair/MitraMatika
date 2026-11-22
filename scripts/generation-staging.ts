// Like scripts/jobs-staging.ts: Vercel Cron runs only on production deployments against the
// production database, so nothing else claims staging jobs; if a production deployment ever points
// at the staging database, disable its cron in Vercel, Settings, Cron Jobs before running this.
// It makes REAL Groq calls (a few thousand free-tier tokens) as a throwaway staging user.
import { eq, inArray } from "drizzle-orm";
import { createGenerationRequest } from "../src/features/generation/service/request";
import { registerGenerationHandlers } from "../src/features/generation/service/register";
import { createCurriculumRepository } from "../src/features/curriculum/service/repository";
import { createDbClient } from "../src/lib/db/client";
import {
  aiCalls,
  generationRequests,
  jobs,
  profiles,
  questions,
} from "../src/lib/db/schema";
import {
  createThrowawayUser,
  deleteThrowawayUser,
  preflightMessage,
  projectRefFromUrl,
  requireStagingConfirmation,
  runChecks,
  summarize,
  type Check,
} from "../src/lib/db/staging-rls";
import { requireDatabaseUrl, requireGroqApiKey } from "../src/lib/env";
import { createJobQueue } from "../src/lib/jobs/queue";
import { createRegistry } from "../src/lib/jobs/registry";
import { runJobs } from "../src/lib/jobs/runner";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  requireStagingConfirmation(process.argv.slice(2), 1);
  requireGroqApiKey();
  const databaseUrl = requireDatabaseUrl();
  console.log(`Basis data: ${projectRefFromUrl(databaseUrl)}`);

  const db = createDbClient(databaseUrl, { max: 6 });
  const queue = createJobQueue(db);
  const registry = createRegistry();
  registerGenerationHandlers(registry);
  let userId: string | undefined;

  try {
    try {
      const busy = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(inArray(jobs.status, ["queued", "deferred", "running"]))
        .limit(1);
      if (busy.length > 0) {
        console.error(
          "Ada pekerjaan lain yang masih antre atau berjalan di proyek ini. Jalankan skrip ini hanya saat tidak ada pekerjaan nyata.",
        );
        process.exitCode = 1;
        return;
      }
    } catch (error) {
      console.error(preflightMessage(error));
      process.exitCode = 1;
      return;
    }

    const curriculum = createCurriculumRepository(db);
    const topics = await curriculum.listTopics(8);
    const version = await curriculum.getActiveVersion();
    if (!version || topics.length === 0) {
      console.error(
        "Belum ada kurikulum Kelas 8 yang aktif di staging (aktifkan seed P1-07 dulu).",
      );
      process.exitCode = 1;
      return;
    }
    const topic = topics[0];

    const email = `generation-${String(Date.now())}@example.test`;
    userId = await createThrowawayUser(db, email);
    await db.insert(profiles).values({ id: userId });
    const owner = userId;

    const request = async (quantity: number) => {
      const result = await createGenerationRequest(db, {
        ownerId: owner,
        topic: { id: topic.id, stableKey: topic.stableKey, title: topic.title },
        curriculumVersionId: version.id,
        quantity,
        difficulty: "sedang",
        now: new Date(),
      });
      if (!result.ok) throw new Error("the request was not created");
      return result.data;
    };

    const checks: Check[] = [
      {
        name: "a real Groq call saves drafts, token rows and a finished request",
        run: async () => {
          const { requestId } = await request(2);
          await runJobs({ queue, registry });
          const row = (
            await db
              .select({ status: generationRequests.status })
              .from(generationRequests)
              .where(eq(generationRequests.id, requestId))
          ).at(0);
          assert(
            row?.status === "succeeded" || row?.status === "partial",
            `request ended as ${String(row?.status)}`,
          );
          const saved = await db
            .select({ id: questions.id })
            .from(questions)
            .where(eq(questions.generationRequestId, requestId));
          assert(saved.length > 0, "no drafts were saved");
          const calls = await db.select().from(aiCalls).where(eq(aiCalls.ownerId, owner));
          assert(calls.length > 0, "no ai_calls row was written");
          assert(
            calls.every((call) => (call.inputTokens ?? 0) > 0),
            "an ai_calls row has no real input tokens",
          );
        },
      },
      {
        name: "two runners at once finish two requests, each with its own single draft",
        run: async () => {
          // createGenerationRequest allows one active request per teacher, so the second pair is
          // inserted directly (the way tests do), then two runners are started together. Each
          // claims one job; the model lock makes the two calls take turns.
          const ids: string[] = [];
          for (let i = 0; i < 2; i += 1) {
            const [row] = await db
              .insert(generationRequests)
              .values({
                ownerId: owner,
                params: {
                  grade: 8,
                  topicId: topic.id,
                  topicStableKey: topic.stableKey,
                  topicTitle: topic.title,
                  curriculumVersionId: version.id,
                  type: "multiple_choice",
                  quantity: 1,
                  difficulty: "sedang",
                },
              })
              .returning({ id: generationRequests.id });
            const job = await queue.enqueue({
              ownerId: owner,
              type: "generate_batch",
              payload: { requestId: row.id },
            });
            await db
              .update(generationRequests)
              .set({ jobId: job.id })
              .where(eq(generationRequests.id, row.id));
            ids.push(row.id);
          }
          await Promise.all([runJobs({ queue, registry }), runJobs({ queue, registry })]);
          for (const id of ids) {
            const saved = await db
              .select({ id: questions.id })
              .from(questions)
              .where(eq(questions.generationRequestId, id));
            if (saved.length !== 1) {
              // Say why: the job's status and error (a rate-limited call is deferred, a bad answer fails).
              const state = (
                await db
                  .select({
                    requestStatus: generationRequests.status,
                    jobStatus: jobs.status,
                    attempts: jobs.attempts,
                    runAfter: jobs.runAfter,
                    error: jobs.error,
                  })
                  .from(generationRequests)
                  .leftJoin(jobs, eq(jobs.id, generationRequests.jobId))
                  .where(eq(generationRequests.id, id))
              ).at(0);
              throw new Error(
                `request ${id} has ${String(saved.length)} drafts, expected 1 (${JSON.stringify(state ?? null)})`,
              );
            }
          }
        },
      },
    ];

    const results = await runChecks(checks);
    for (const result of results) {
      console.log(
        result.ok
          ? `  ok    ${result.name}`
          : `  GAGAL ${result.name}: ${String(result.error)}`,
      );
    }
    const { passed, failed } = summarize(results);
    console.log(`\n${String(passed)} lolos, ${String(failed)} gagal.`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    // Deleting the user row cascades through the profile to every row it owns.
    if (userId) {
      try {
        await deleteThrowawayUser(db, userId);
      } catch (error) {
        console.error(
          `Pengguna sementara ${userId} belum terhapus: ${error instanceof Error ? error.message : String(error)}. Hapus manual dari tabel "user".`,
        );
        process.exitCode = 1;
      }
    }
    // drizzle-orm sets `$client` at runtime, but createDbClient's declared return type omits it.
    // The handler's own pool (getDb) is cached on globalThis; close it too so the process exits.
    const handlerDb = (
      globalThis as unknown as {
        __mitramatikaDb?: { $client: { end(): Promise<void> } };
      }
    ).__mitramatikaDb;
    await handlerDb?.$client.end();
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
  }
}

main().catch((error: unknown) => {
  console.error("Skrip gagal:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
