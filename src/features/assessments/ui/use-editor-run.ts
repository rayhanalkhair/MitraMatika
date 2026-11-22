"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import type { ActionResult } from "../actions/result";

type Outcome = ActionResult<Record<string, unknown>>;
type Success = Extract<Outcome, { ok: true }>;
type Failure = Extract<Outcome, { ok: false }>;

export interface RunOptions {
  /** The sentence announced on success. */
  done: string | ((result: Success) => string);
  /**
   * The ids of the controls that should take focus after the refresh (the first one that exists
   * and is enabled). A control that was pressed is disabled while the action runs and may be gone
   * after it, so the keyboard would otherwise fall back to the page.
   */
  focus?: string[] | ((result: Success) => string[]);
  /** Runs only when the action succeeded (clear what the teacher typed or checked). */
  onSuccess?: () => void;
  /** A message for a refusal that names more than the key does; null falls back to the key. */
  refused?: (failure: Failure) => string | null;
  /** Refresh the page after a refusal too (the server's view changed: show it). */
  refreshOnRefusal?: boolean;
}

export type RunEditorAction = (work: () => Promise<Outcome>, options: RunOptions) => void;

/**
 * Runs one editor action and refreshes the page on success. The outcome is a short sentence for the
 * editor's live regions (a notice, or the problem the service reported).
 */
export function useEditorRun() {
  const t = useTranslations("assessments");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState("");
  const [problem, setProblem] = useState("");
  const [focusIds, setFocusIds] = useState<string[]>([]);

  const run = useCallback<RunEditorAction>(
    (work, options) => {
      setNotice("");
      setProblem("");
      startTransition(async () => {
        const result = await work();
        if (result.ok) {
          setNotice(
            typeof options.done === "string" ? options.done : options.done(result),
          );
          setFocusIds(
            typeof options.focus === "function"
              ? options.focus(result)
              : (options.focus ?? []),
          );
          options.onSuccess?.();
          router.refresh();
        } else {
          setProblem(options.refused?.(result) ?? t(`errors.${result.reason}`));
          setFocusIds(typeof options.focus === "function" ? [] : (options.focus ?? []));
          if (options.refreshOnRefusal === true) router.refresh();
        }
      });
    },
    [router, t],
  );

  const clearFocus = useCallback(() => {
    setFocusIds([]);
  }, []);

  return { pending, notice, problem, focusIds, clearFocus, run };
}
