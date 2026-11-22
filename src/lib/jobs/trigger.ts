import "server-only";
import { after } from "next/server";
import { runDefaultJobs } from "./default";
import { logger } from "@/lib/logger";

/**
 * Callers: server actions right after they enqueue, and the job status route when a poll finds
 * its job due (queued or deferred past run_after, or an expired lease), so a short retry does not
 * wait for the daily run.
 *
 * Call this right after enqueueing a job in a server action: the runner starts after the response
 * is sent. In a server action the run happens within the CALLING PAGE's maxDuration (Next 16: a
 * Server Action's timeout is the page's maxDuration), so every page whose actions call
 * scheduleRun must `export const maxDuration = 300` (P1-09). Outside a request scope after()
 * throws, so call scheduleRun only after the enqueue has committed and do not report an action
 * failure if it throws (the next kick or the daily run still picks the job up). Errors inside the run are logged and
 * never affect the response.
 */
export function scheduleRun(run: () => Promise<unknown> = runDefaultJobs): void {
  after(async () => {
    try {
      await run();
    } catch (error) {
      logger.error({ module: "jobs", err: error }, "jobs: scheduled run failed");
    }
  });
}
