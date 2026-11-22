import { toNextJsHandler } from "better-auth/next-js";
import { getAuth, requestWithClientIp } from "@/features/auth";
import { logger } from "@/lib/logger";

// after() is bound to the route's maxDuration, and the account emails (verification, reset,
// account exists) are sent after the response. 30 s is generous for one Resend call (which has its own 10 s timeout) and stops a
// stuck function from holding a slot for the platform default.
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "no-store" };

// Better Auth is built on the first request, never when this module loads, and answers 503
// instead of crashing while BETTER_AUTH_SECRET or BETTER_AUTH_URL is missing.
async function handle(request: Request): Promise<Response> {
  let auth: ReturnType<typeof getAuth>;
  try {
    auth = getAuth();
  } catch (error) {
    logger.error({ module: "auth", err: error }, "auth: Better Auth is not configured");
    return Response.json(
      { error: "auth_unavailable" },
      { status: 503, headers: NO_STORE },
    );
  }
  // A client may send the dedicated client IP header itself: overwrite it (or drop it) with the
  // address resolved from the platform before Better Auth rate limits by it.
  return auth.handler(await requestWithClientIp(request));
}

export const { GET, POST } = toNextJsHandler(handle);
