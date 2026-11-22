import "server-only";
import { after } from "next/server";
import { logger } from "@/lib/logger";

type Schedule = (callback: () => Promise<unknown>) => void;

// The message Next's after() throws when there is no request (next/dist/server/after/after.js).
const OUTSIDE_REQUEST_SCOPE = "outside a request scope";

function isOutsideRequestScope(error: unknown): boolean {
  return error instanceof Error && error.message.includes(OUTSIDE_REQUEST_SCOPE);
}

// Better Auth's `advanced.backgroundTasks.handler`: work it hands over (the sign-in code email)
// runs after the response is sent, so a slow or hanging send never shows in the response time.
// Inside a request, Next's after() keeps the function alive until the task settles. Outside one
// (tests, scripts) after() throws, and the already-started task simply runs on its own.
export function runAfterResponse(
  task: Promise<unknown>,
  schedule: Schedule = after,
): void {
  // Never an unhandled rejection, whatever the caller passed in.
  const settled = task.catch(() => undefined);
  try {
    schedule(() => settled);
  } catch (error) {
    // Only the "outside a request scope" refusal is expected (nothing to extend, the task is
    // already running). Anything else is logged, by name only, and still never thrown: this
    // runs in the request path.
    if (!isOutsideRequestScope(error)) {
      logger.error(
        { module: "auth", errorName: error instanceof Error ? error.name : "unknown" },
        "auth: could not schedule the background task",
      );
    }
  }
}
