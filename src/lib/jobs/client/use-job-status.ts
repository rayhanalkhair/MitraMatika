"use client";

import { skipToken, useQuery } from "@tanstack/react-query";
import { fetchJobStatus, pollIntervalFor } from "./status";

// Polls a job's status: every 2 s while queued/running, every 15 s while deferred, and stops once
// it has finished (and every 15 s after a failed fetch). Refetches when the window regains focus so a second device catches up.
export function useJobStatus(jobId: string | null) {
  return useQuery({
    queryKey: ["job-status", jobId],
    queryFn: jobId === null ? skipToken : () => fetchJobStatus(jobId),
    refetchOnWindowFocus: true,
    retry: 2,
    refetchInterval: (query) => pollIntervalFor(query.state),
  });
}
