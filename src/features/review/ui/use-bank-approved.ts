"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { bankApprovedAction } from "@/features/generation/actions/create-request";
import type { BankActionResult } from "@/features/generation/actions/create-request";
import { patchReviewBanked, type ReviewResult } from "./review-client";
import { reviewQueryKey } from "./review-query";

export function useBankApproved(requestId: string) {
  const queryClient = useQueryClient();
  const mutation = useMutation<BankActionResult>({
    mutationFn: async () => {
      try {
        return await bankApprovedAction({ requestId });
      } catch {
        // A network or server failure: the same outcome as a generic failure.
        return { ok: false, reason: "generic" };
      }
    },
    onSuccess: (result) => {
      // Show the saved state at once; the invalidation below then fetches the truth.
      if (!result.ok) return;
      queryClient.setQueryData<ReviewResult>(reviewQueryKey(requestId), (old) =>
        old?.kind === "ok" ? { kind: "ok", review: patchReviewBanked(old.review) } : old,
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: reviewQueryKey(requestId) }),
  });

  return {
    save: (): Promise<BankActionResult> => mutation.mutateAsync(),
    pending: mutation.isPending,
  };
}
