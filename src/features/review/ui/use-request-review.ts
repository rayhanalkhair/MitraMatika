"use client";

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { isTerminal } from "@/lib/jobs/client/status";
import type { JobStatusValue } from "@/lib/jobs/status";
import { reviewRefetchInterval, type ReviewJobStatus } from "./review-client";
import { reviewQueryOptions } from "./review-query";

const isKnown = (status: ReviewJobStatus): status is JobStatusValue =>
  status !== undefined && status !== "stopped" && status !== "unreachable";

export function useRequestReview(requestId: string, jobStatus: ReviewJobStatus) {
  const query = useQuery({
    ...reviewQueryOptions(requestId),
    refetchOnWindowFocus: true,
    retry: 2,
    refetchInterval: (q) => reviewRefetchInterval(q.state, jobStatus),
  });
  // One more fetch when the job turns terminal, so the last statuses are never missed. That covers
  // a known running status and also a review fetched while the job status was still unknown (it may
  // predate the final verification). At load the first fetch already covers a finished job.
  const previous = useRef<ReviewJobStatus | "initial">("initial");
  const { refetch } = query;
  useEffect(() => {
    const before = previous.current;
    if (before !== "initial" && isKnown(jobStatus) && isTerminal(jobStatus)) {
      const wasRunning = isKnown(before) && !isTerminal(before);
      const wasUnknown = before === undefined || before === "unreachable";
      if (wasRunning || wasUnknown) void refetch();
    }
    previous.current = jobStatus;
  }, [jobStatus, refetch]);
  return query;
}
