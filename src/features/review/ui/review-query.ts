import { queryOptions } from "@tanstack/react-query";
import { fetchRequestReview } from "./review-client";

// The one definition of the review query, shared by every hook that reads it so the key and the
// fetch function cannot drift apart.
export const reviewQueryKey = (requestId: string) =>
  ["request-review", requestId] as const;

export const reviewQueryOptions = (requestId: string) =>
  queryOptions({
    queryKey: reviewQueryKey(requestId),
    queryFn: () => fetchRequestReview(requestId),
  });
