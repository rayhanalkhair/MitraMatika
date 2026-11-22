"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { RegenerateControl } from "@/features/review/ui/RegenerateControl";
import type { ReviewQuestion } from "@/features/review";

// The detail page's regenerate control: a finished job or a restore re-reads the page. A version
// the checks contradicted sends the question back to review and out of the bank, so the page would
// have nothing to show: the control's own notice explains that instead.
export function BankRegenerate({ question }: { question: ReviewQuestion }) {
  const router = useRouter();
  const onSettled = useCallback(
    (step?: string) => {
      if (step !== "returned_to_review") router.refresh();
    },
    [router],
  );
  // The detail card is an h2, so the comparison is an h3.
  return (
    <RegenerateControl
      question={question}
      onSettled={onSettled}
      compareHeadingLevel={3}
    />
  );
}
