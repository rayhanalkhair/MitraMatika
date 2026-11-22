"use client";

import { useEffect, useEffectEvent } from "react";
import type {
  FieldErrors,
  FieldPath,
  FieldValues,
  UseFormSetError,
} from "react-hook-form";

/**
 * Field errors from a Server Action's state: field name (an RHF path such as `options.2.textMd`) to
 * an i18n error key. The keys are the same ones the shared Zod schema uses in the browser.
 */
export type ServerFieldErrors = Partial<Record<string, string>>;

function entriesOf(fieldErrors: ServerFieldErrors | undefined): [string, string][] {
  return Object.entries(fieldErrors ?? {}).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
  );
}

/**
 * The same errors as React Hook Form's `errors` object (nested by path, type "server"), for the
 * first render: a post without JavaScript renders the action's state on the server, where effects
 * never run. Undefined when there are none.
 */
export function toFormErrors<T extends FieldValues>(
  fieldErrors: ServerFieldErrors | undefined,
): FieldErrors<T> | undefined {
  const entries = entriesOf(fieldErrors);
  if (entries.length === 0) return undefined;
  const root: Record<string, unknown> = {};
  for (const [name, message] of entries) {
    const path = name.split(".");
    const last = path.pop() ?? name;
    let node = root;
    for (const segment of path) {
      const next = node[segment];
      const child: Record<string, unknown> =
        typeof next === "object" && next !== null
          ? (next as Record<string, unknown>)
          : {};
      node[segment] = child;
      node = child;
    }
    node[last] = { type: "server", message };
  }
  return root as FieldErrors<T>;
}

/**
 * Copies a Server Action's field errors into React Hook Form with `setError` whenever the
 * `fieldErrors` object changes (pass the object from the action state, not a copy made during
 * render). They clear like client errors: live re-validation drops a field's error once it is
 * valid. `onApplied` runs after at least one error was set, before the re-render that shows them.
 */
export function useServerFieldErrors<T extends FieldValues>(
  form: { setError: UseFormSetError<T> },
  fieldErrors: ServerFieldErrors | undefined,
  onApplied?: () => void,
): void {
  const { setError } = form;
  const applied = useEffectEvent(() => {
    onApplied?.();
  });
  useEffect(() => {
    const entries = entriesOf(fieldErrors);
    if (entries.length === 0) return;
    for (const [name, message] of entries) {
      setError(name as FieldPath<T>, { type: "server", message });
    }
    applied();
  }, [setError, fieldErrors]);
}
