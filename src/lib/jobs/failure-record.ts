import type { ErrorEntry } from "@/lib/events";
import { isValidEventName } from "@/lib/events/sanitize";
import type { FailureInfo } from "./runner";

// Maps a permanently failed job to an app_errors record. A job type that is not a valid event
// name is recorded under the generic "job" source (with the type kept in context) rather than
// being dropped.
export function failureToErrorEntry({ job, failure }: FailureInfo): ErrorEntry {
  const source = `job:${job.type}`;
  return {
    ownerId: job.ownerId,
    correlationId: job.correlationId,
    source: isValidEventName(source) ? source : "job",
    code: failure.code,
    message: failure.message,
    context: { jobId: job.id, attempts: job.attempts + 1, type: job.type },
  };
}
