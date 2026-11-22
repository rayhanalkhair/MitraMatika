import "server-only";
import type { ActionAuthorization } from "@/features/auth";
import { isUuid } from "@/lib/jobs/status";
import type { RequestReview } from "./review";
import { logger } from "@/lib/logger";

const NO_STORE = { "Cache-Control": "no-store" };

export interface ReviewRouteDeps {
  authorize: () => Promise<ActionAuthorization>;
  readReview: (userId: string, requestId: string) => Promise<RequestReview | null>;
}

const notFound = () =>
  Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

/**
 * GET handler body for a request's review. 401 when there is no signed-in user; a malformed id,
 * a missing request and another teacher's request all answer the same 404.
 */
export async function handleReviewRequest(
  requestId: string,
  deps: ReviewRouteDeps,
): Promise<Response> {
  const authorization = await deps.authorize();
  if (!authorization.ok) {
    return Response.json(
      { error: authorization.error },
      { status: 401, headers: NO_STORE },
    );
  }
  // A malformed id, a missing request and another teacher's request all look the same.
  if (!isUuid(requestId)) return notFound();
  try {
    const review = await deps.readReview(authorization.data.userId, requestId);
    if (!review) return notFound();
    return Response.json(review, { headers: NO_STORE });
  } catch (error) {
    logger.error(
      { module: "generation", code: (error as { code?: unknown } | null)?.code ?? "" },
      "generation: review read failed",
    );
    return Response.json({ error: "unavailable" }, { status: 500, headers: NO_STORE });
  }
}
