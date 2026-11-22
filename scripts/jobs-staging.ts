// This script enqueues jobs straight into the staging database, so the app's after() kick never
// fires for them. Vercel Cron runs only on production deployments against the production
// database, so nothing else claims staging jobs; if a production deployment ever points at the
// staging database, disable its cron in Vercel, Settings, Cron Jobs before running this.
import { randomUUID } from "node:crypto";
import { eq, inArray, ne, sql } from "drizzle-orm";
import { createDbClient, runAsUser } from "../src/lib/db/client";
import { jobs, profiles } from "../src/lib/db/schema";
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
import { createJobQueue } from "../src/lib/jobs/queue";
import { readJobStatus } from "../src/lib/jobs/status";
import { requireDatabaseUrl } from "../src/lib/env";

const JOB_COUNT = 20;
const CLAIMERS = 8;
const LEASE_MS = 600_000;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  requireStagingConfirmation(process.argv.slice(2), 1);
  const databaseUrl = requireDatabaseUrl();
  console.log(`Basis data: ${projectRefFromUrl(databaseUrl)}`);

  const db = createDbClient(databaseUrl, { max: CLAIMERS + 2 });
  const queue = createJobQueue(db);
  let userId: string | undefined;

  try {
    // The claim query takes ANY due job and reclaim touches ANY stale one, so refuse to run while
    // real work exists in this project: the script would steal or disturb it.
    try {
      const busy = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(inArray(jobs.status, ["queued", "deferred", "running"]))
        .limit(1);
      if (busy.length > 0) {
        console.error(
          "Ada pekerjaan lain yang masih antre atau berjalan di proyek ini. Jalankan skrip ini hanya saat tidak ada pekerjaan nyata, supaya tidak mengganggunya.",
        );
        process.exitCode = 1;
        return;
      }
    } catch (error) {
      console.error(preflightMessage(error));
      process.exitCode = 1;
      return;
    }

    const email = `jobs-${String(Date.now())}@example.test`;
    userId = await createThrowawayUser(db, email);
    await db.insert(profiles).values({ id: userId });
    const owner = userId;

    // Everything not owned by the throwaway user must come out of the run exactly as it went in.
    const snapshotOthers = async (): Promise<string> => {
      const rows = await db
        .select({
          id: jobs.id,
          status: jobs.status,
          attempts: jobs.attempts,
          updatedAt: jobs.updatedAt,
        })
        .from(jobs)
        .where(ne(jobs.ownerId, owner))
        .orderBy(jobs.id);
      return JSON.stringify(
        rows.map((row) => [
          row.id,
          row.status,
          row.attempts,
          row.updatedAt.toISOString(),
        ]),
      );
    };
    const othersBefore = await snapshotOthers();

    const checks: Check[] = [
      {
        name: `${String(CLAIMERS)} concurrent claimers claim each of ${String(JOB_COUNT)} jobs exactly once`,
        run: async () => {
          for (let i = 0; i < JOB_COUNT; i += 1) {
            await queue.enqueue({ ownerId: owner, type: "jobs_staging_check" });
          }
          const claimed: string[] = [];
          await Promise.all(
            Array.from({ length: CLAIMERS }, async () => {
              for (;;) {
                const job = await queue.claimNext();
                if (!job) return;
                claimed.push(job.id);
              }
            }),
          );
          assert(
            claimed.length === JOB_COUNT,
            `expected ${String(JOB_COUNT)} claims, got ${String(claimed.length)}`,
          );
          assert(new Set(claimed).size === JOB_COUNT, "a job was claimed more than once");
        },
      },
      {
        name: "a crashed runner's job is reclaimed and can be finished",
        run: async () => {
          const job = await queue.enqueue({ ownerId: owner, type: "jobs_staging_check" });
          const claim = await queue.claimNext();
          assert(claim, "no job could be claimed");
          assert(claim.id === job.id, "claimed an unexpected job");
          // Simulate the crash: the runner died an hour ago and never reported back.
          await db
            .update(jobs)
            .set({ lockedAt: sql`now() - interval '1 hour'` })
            .where(eq(jobs.id, job.id));
          assert(
            (await queue.reclaimStale(LEASE_MS)) === 1,
            "expected exactly one reclaimed job",
          );
          const row = (await db.select().from(jobs).where(eq(jobs.id, job.id))).at(0);
          assert(
            row?.status === "queued" && row.attempts === 1,
            "job was not re-queued with one failure",
          );
          const resumed = await queue.claimNext();
          assert(resumed, "the reclaimed job was not claimed");
          assert(resumed.id === job.id, "the reclaimed job was not claimed again");
          assert(
            !(await queue.complete({ id: claim.id, lockToken: claim.lockToken })),
            "the old claim could still complete the job",
          );
          assert(
            await queue.complete({ id: resumed.id, lockToken: resumed.lockToken }),
            "the new claim could not complete the job",
          );
        },
      },
      {
        name: "runAsUser reads the owner's job through RLS and hides it from another user",
        run: async () => {
          // Positive proof first: a negative-only check would also pass if auth.uid() were null.
          const claims = await runAsUser(db, owner, async (tx) =>
            tx.execute(sql`select current_user as role, auth.uid()::text as uid`),
          );
          const rows = (
            Array.isArray(claims) ? claims : ((claims as { rows?: unknown[] }).rows ?? [])
          ) as { role?: string; uid?: string }[];
          const claim = rows.at(0);
          assert(
            claim?.role === "authenticated",
            `runAsUser ran as role ${String(claim?.role)}, expected authenticated`,
          );
          assert(
            claim.uid === owner,
            `auth.uid() was ${String(claim.uid)} inside runAsUser, expected the owner`,
          );
          const job = await queue.enqueue({ ownerId: owner, type: "jobs_staging_check" });
          const own = await readJobStatus(db, owner, job.id);
          assert(
            own !== null && own.id === job.id,
            "the owner could not read their own job",
          );
          const other = await readJobStatus(db, randomUUID(), job.id);
          assert(other === null, "a different user could read the job");
        },
      },
      {
        name: "jobs of other users were never touched",
        run: async () => {
          assert(
            (await snapshotOthers()) === othersBefore,
            "another user's job was added, removed or changed (id, status, attempts, updated_at)",
          );
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
    // Deleting the user row cascades through the profile to every job it owns.
    if (userId) {
      try {
        await deleteThrowawayUser(db, userId);
      } catch (error) {
        console.error(
          `Gagal menghapus pengguna ${userId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
      }
    }
    // drizzle-orm sets `$client` at runtime, but createDbClient's declared return type omits it.
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    "Uji antrean pekerjaan gagal:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
