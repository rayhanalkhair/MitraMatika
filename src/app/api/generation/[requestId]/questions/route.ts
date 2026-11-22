import { handleReviewRequest } from "@/features/review";
import { getRequestReview } from "@/features/review";
import type { AnyDb } from "@/features/generation";
import { authorizeAction } from "@/features/auth";
import { runAsUser } from "@/lib/db/client";
import { getDb } from "@/lib/db/runtime";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ requestId: string }> },
): Promise<Response> {
  const { requestId } = await params;
  return handleReviewRequest(requestId, {
    authorize: authorizeAction,
    // Under RLS: another teacher's request is simply not found.
    readReview: (userId, id) =>
      runAsUser(getDb(), userId, (tx) =>
        getRequestReview(tx as unknown as AnyDb, { ownerId: userId, requestId: id }),
      ),
  });
}
