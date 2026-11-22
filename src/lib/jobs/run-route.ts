import "server-only";
import { isRunnerAuthorized, MIN_SECRET_LENGTH } from "./auth";
import { logger } from "@/lib/logger";

const NO_STORE = { "Cache-Control": "no-store" };

let misconfigWarned = false;

/**
 * A missing or short CRON_SECRET makes every run 401, silently, and Hobby keeps runtime logs for
 * one hour: warn once per process in production so a cold start shows it. Never logs a value.
 */
function warnIfMisconfigured(secret: string | undefined): void {
  if (misconfigWarned || process.env.NODE_ENV !== "production") return;
  if (secret && secret.length >= MIN_SECRET_LENGTH) return;
  misconfigWarned = true;
  logger.warn(
    { module: "jobs" },
    `jobs: CRON_SECRET is unset or shorter than ${String(MIN_SECRET_LENGTH)} characters; every run is refused`,
  );
}

/** Who asked for the run: Vercel Cron (GET) or a person or the e2e helper (POST). */
export type RunTrigger = "cron" | "manual";

/**
 * The runner works for up to 240 s but a caller (Vercel Cron, a manual run) should not wait that
 * long, so a valid request schedules the run for after the response and answers 202 straight away.
 * Errors inside the scheduled run are logged and never reach the caller.
 */
export function handleRunRequest(
  request: Request,
  secret: string | undefined,
  schedule: (task: () => Promise<void>) => void,
  run: (trigger: RunTrigger) => Promise<unknown>,
  trigger: RunTrigger,
): Response {
  warnIfMisconfigured(secret);
  if (!isRunnerAuthorized(request.headers.get("authorization"), secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  schedule(async () => {
    try {
      await run(trigger);
    } catch (error) {
      logger.error({ module: "jobs", err: error }, "jobs: run failed");
    }
  });
  return Response.json({ accepted: true }, { status: 202, headers: NO_STORE });
}
