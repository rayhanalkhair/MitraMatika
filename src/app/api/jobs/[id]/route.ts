import { authorizeAction } from "@/features/auth";
import { getDb } from "@/lib/db/runtime";
import { readJobStatusAndDue } from "@/lib/jobs/status";
import { scheduleRun } from "@/lib/jobs/trigger";
import { handleStatusRequest } from "@/features/auth";

// A poll that finds its job due starts the runner in this request's after(), so it is bound to
// this route's maxDuration (the same budget as /api/jobs/run).
export const maxDuration = 300;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return handleStatusRequest(id, {
    authorize: authorizeAction,
    readJob: (userId, jobId) => readJobStatusAndDue(getDb(), userId, jobId),
    kick: () => {
      scheduleRun();
    },
  });
}
