"use client";

import { useQuery } from "@tanstack/react-query";
import { reviewQueryOptions } from "./review-query";

// Whether the review list of a request has arrived, or its load has failed. It watches the same
// query as `ReviewList` (shared options) without fetching on its own (`enabled: false`), so it adds
// no request and no polling.
export function useReviewLoaded(requestId: string): {
  loaded: boolean;
  isError: boolean;
} {
  const query = useQuery({ ...reviewQueryOptions(requestId), enabled: false });
  return { loaded: query.data !== undefined, isError: query.isError };
}
