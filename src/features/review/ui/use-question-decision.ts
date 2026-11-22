"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { decideQuestionAction } from "@/features/generation/actions/create-request";
import type { DecisionActionResult } from "@/features/generation/actions/create-request";
import type { DecisionAction } from "@/features/review/service/decision";
import type { ReviewQuestion } from "@/features/review/service/review";
import { patchReviewDecision, type ReviewResult } from "./review-client";
import { reviewQueryKey } from "./review-query";

interface Vars {
  question: ReviewQuestion;
  action: DecisionAction;
  overrideNote?: string;
}
type Failure = Extract<DecisionActionResult, { ok: false }>;
type Success = Extract<DecisionActionResult, { ok: true }>;

// A decision failure reason maps to a key under `review.decision.errors`.
const REASON_KEY = {
  already_saved: "alreadySaved",
  conflict: "conflict",
  not_found: "notFound",
  override_required: "overrideRequired",
  invalid_note: "invalidNote",
  not_ready: "notReady",
  signed_out: "signedOut",
  invalid: "invalid",
  generic: "generic",
} as const satisfies Record<Failure["reason"], string>;

const DECISION_OF = { approve: "approved", reject: "rejected", reset: "draft" } as const;

class DecisionFailure extends Error {
  constructor(readonly failure: Failure) {
    super(failure.reason);
  }
}

export function useQuestionDecision(requestId: string) {
  const t = useTranslations("review.decision.errors");
  const queryClient = useQueryClient();
  const queryKey = reviewQueryKey(requestId);
  const [messages, setMessages] = useState<Record<string, string>>({});
  // Several decisions on different questions can be in flight at once.
  const [pendingQuestionIds, setPendingQuestionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const setPending = (questionId: string, pending: boolean) => {
    setPendingQuestionIds((current) => {
      if (current.has(questionId) === pending) return current;
      const next = new Set(current);
      if (pending) next.add(questionId);
      else next.delete(questionId);
      return next;
    });
  };

  const clearError = (questionId: string) => {
    setMessages((current) => {
      if (!(questionId in current)) return current;
      return Object.fromEntries(
        Object.entries(current).filter(([id]) => id !== questionId),
      );
    });
  };

  const mutation = useMutation<
    Success,
    Error,
    Vars,
    { previousQuestion: ReviewQuestion | undefined }
  >({
    mutationFn: async ({ question, action, overrideNote }) => {
      let result: DecisionActionResult;
      try {
        result = await decideQuestionAction({
          questionId: question.questionId,
          versionId: question.versionId,
          rowVersion: question.rowVersion,
          action,
          ...(overrideNote !== undefined ? { overrideNote } : {}),
        });
      } catch {
        // A network or server failure: the same outcome as a generic failure.
        result = { ok: false, reason: "generic" };
      }
      if (!result.ok) throw new DecisionFailure(result);
      return result;
    },
    onMutate: async ({ question, action, overrideNote }) => {
      clearError(question.questionId);
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ReviewResult>(queryKey);
      // Snapshot only the target question: a rollback must not touch other questions.
      const previousQuestion =
        previous?.kind === "ok"
          ? previous.review.questions.find(
              (item) => item.questionId === question.questionId,
            )
          : undefined;
      if (previous?.kind === "ok") {
        const patched: ReviewResult = {
          kind: "ok",
          review: patchReviewDecision(
            previous.review,
            question.questionId,
            DECISION_OF[action],
            action === "approve" && overrideNote !== undefined,
          ),
        };
        queryClient.setQueryData(queryKey, patched);
      }
      return { previousQuestion };
    },
    onError: (error, { question }, context) => {
      // Restore only the decision fields of the target question. A poll can land while a decision
      // is in flight, so the rest of the row (versionId, content) may be newer than the snapshot.
      const current = queryClient.getQueryData<ReviewResult>(queryKey);
      const snapshot = context?.previousQuestion;
      if (current?.kind === "ok" && snapshot) {
        const restored: ReviewResult = {
          kind: "ok",
          review: {
            ...current.review,
            questions: current.review.questions.map((item) =>
              item.questionId === snapshot.questionId
                ? {
                    ...item,
                    decision: snapshot.decision,
                    override: snapshot.override,
                    rowVersion: snapshot.rowVersion,
                  }
                : item,
            ),
          },
        };
        queryClient.setQueryData(queryKey, restored);
      }
      const reason = error instanceof DecisionFailure ? error.failure.reason : "generic";
      setMessages((current) => ({
        ...current,
        [question.questionId]: t(REASON_KEY[reason]),
      }));
    },
    onSuccess: (result, { question }) => {
      // Take the server's row version and override flag over the optimistic guess.
      const current = queryClient.getQueryData<ReviewResult>(queryKey);
      if (current?.kind === "ok") {
        const synced: ReviewResult = {
          kind: "ok",
          review: {
            ...current.review,
            questions: current.review.questions.map((item) =>
              item.questionId === question.questionId
                ? {
                    ...item,
                    decision: result.decision,
                    override: result.override,
                    rowVersion: result.rowVersion,
                  }
                : item,
            ),
          },
        };
        queryClient.setQueryData(queryKey, synced);
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });

  const decide = async (
    question: ReviewQuestion,
    action: DecisionAction,
    overrideNote?: string,
  ): Promise<DecisionActionResult> => {
    setPending(question.questionId, true);
    try {
      return await mutation.mutateAsync({
        question,
        action,
        ...(overrideNote !== undefined ? { overrideNote } : {}),
      });
    } catch (error) {
      return error instanceof DecisionFailure
        ? error.failure
        : { ok: false, reason: "generic" };
    } finally {
      setPending(question.questionId, false);
    }
  };

  return {
    decide,
    pendingQuestionIds,
    isPending: (questionId: string): boolean => pendingQuestionIds.has(questionId),
    errorFor: (questionId: string): string | null => messages[questionId] ?? null,
  };
}
