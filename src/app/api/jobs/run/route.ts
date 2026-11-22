import { after } from "next/server";
import { pruneUnverifiedAccounts } from "@/features/auth";
import { backfillBankSearchText } from "@/features/bank";
import { settleStrandedRegenerations } from "@/features/generation";
import { purgeExports } from "@/features/export";
import { sweepMaterials } from "@/features/materials";
import { sweepSolver } from "@/features/solver";
import { purgeTrash } from "@/features/trash";
import { getDb } from "@/lib/db/runtime";
import { readCronSecret } from "@/lib/jobs/auth";
import { runDefaultJobs } from "@/lib/jobs/default";
import { recordRun } from "@/lib/jobs/run-record";
import { handleRunRequest, type RunTrigger } from "@/lib/jobs/run-route";
import { runTick } from "@/lib/jobs/tick";
import { logger } from "@/lib/logger";

// The daily run (vercel.json `crons`, "0 19 * * *" = 02:00 to 02:59 Asia/Jakarta). Vercel facts this
// relies on, each to verify after the first production deploy:
// - Vercel Cron calls the production deployment only (never previews);
// - it sends `GET` with `Authorization: Bearer $CRON_SECRET` (CRON_SECRET set in Vercel);
// - its user agent is `vercel-cron/1.0`;
// - it does not retry a failed call and does not follow redirects (so this path must not redirect);
// - on Hobby it fires somewhere within the scheduled hour, and at most once a day per job.
// POST stays for manual runs and the e2e helper, behind the same Bearer check. GET Route Handlers
// are dynamic by default (Next.js 15+), and this one reads the request headers.

// Vercel Hobby's maximum; the run (housekeeping plus the runner) ends within 240 s of the request.
export const maxDuration = 300;

export function GET(request: Request): Promise<Response> {
  return handle(request, "cron");
}

export function POST(request: Request): Promise<Response> {
  return handle(request, "manual");
}

// Next would otherwise answer HEAD by running GET, a third (mislabelled) way to start the run.
export function HEAD(): Response {
  return new Response(null, {
    status: 405,
    headers: { Allow: "GET, POST", "Cache-Control": "no-store" },
  });
}

function handle(request: Request, trigger: RunTrigger): Promise<Response> {
  // The run's budget counts from here (src/lib/jobs/tick.ts): the runner gets what the
  // housekeeping left of 240 s, so the whole function stays inside its 300 s.
  const startedAt = Date.now();
  return Promise.resolve(
    handleRunRequest(
      request,
      readCronSecret(),
      (task) => {
        after(task);
      },
      // Cheap database-only steps first, then the storage ones (decision 11): settle approvals
      // left by regenerations that died (R19); delete unverified sign-ups older than 7 days and
      // expired limit rows; fill the search text of questions that predate it; once per Jakarta
      // day purge the expired trash (at most 60 s of new rows plus one 45 s store call); delete
      // the exported files whose 7 days are over (30 s + 15 s); fail materials whose ingestion
      // died and sweep expired upload reservations (20 s + 10 s); delete solver photos 7 days
      // after their session (15 s + 10 s). No step starts after 120 s (HOUSEKEEPING_CUTOFF_MS);
      // none throws. The run's record (audit_log `jobs_run`) is written last, in the same task.
      async (runTrigger) => {
        logger.info({ module: "jobs", trigger: runTrigger }, "jobs: run started");
        const result = await runTick({
          startedAt,
          housekeeping: [
            { name: "settleRegenerations", run: () => settleStrandedRegenerations() },
            { name: "pruneAccounts", run: () => pruneUnverifiedAccounts() },
            // The capped steps get the time left before the cutoff as their budget ceiling.
            { name: "backfillSearchText", run: (left) => backfillBankSearchText(left) },
            { name: "purgeTrash", run: (left) => purgeTrash(new Date(), left) },
            { name: "purgeExports", run: (left) => purgeExports(new Date(), left) },
            { name: "sweepMaterials", run: (left) => sweepMaterials(new Date(), left) },
            { name: "sweepSolver", run: (left) => sweepSolver(new Date(), left) },
          ],
          runJobs: runDefaultJobs,
        });
        await recordRun(getDb(), { at: new Date(), trigger: runTrigger, result });
      },
      trigger,
    ),
  );
}
