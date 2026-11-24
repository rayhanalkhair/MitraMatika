import "server-only";
import { isOwnerApproved } from "@/features/auth";
import { registerExportHandlers } from "@/features/export";
import { registerGenerationHandlers } from "@/features/generation";
import { registerMaterialHandlers } from "@/features/materials";
import { registerSolverHandlers } from "@/features/solver";
import { getDb } from "@/lib/db/runtime";
import { error as recordJobError } from "@/lib/events";
import { failureToErrorEntry } from "./failure-record";
import { createJobQueue } from "./queue";
import { createJobRunLog } from "./run-log";
import { createRegistry } from "./registry";
import { runJobs, type RunSummary } from "./runner";
import type { JobQueue } from "./types";

// Handlers are registered on this registry by the modules that own them; this file is the
// composition root that wires them in.
export const defaultRegistry = createRegistry();
registerGenerationHandlers(defaultRegistry);
registerExportHandlers(defaultRegistry);
registerMaterialHandlers(defaultRegistry);
registerSolverHandlers(defaultRegistry);

export function getJobQueue(): JobQueue {
  return createJobQueue(getDb());
}

/** Runs the registered jobs; `budgetMs` is what the daily run left (runner.ts DEFAULT_BUDGET_MS by default). */
export function runDefaultJobs(budgetMs?: number): Promise<RunSummary> {
  return runJobs({
    budgetMs,
    queue: getJobQueue(),
    registry: defaultRegistry,
    runs: createJobRunLog(getDb()),
    // An account that is not approved (any more) has its queued jobs failed, not run.
    canRun: (ownerId) => isOwnerApproved(ownerId),
    onFailure: async ({ job, failure }) => {
      await recordJobError(failureToErrorEntry({ job, failure }));
    },
  });
}
