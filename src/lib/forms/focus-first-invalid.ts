"use client";

import { useEffect, type RefObject } from "react";

/**
 * Focuses the first invalid control inside `root` in DOM order, if any: an
 * `[aria-invalid="true"]` control, or a radio group marked `data-invalid="true"` (a radio does not
 * support aria-invalid), whose checked radio, else its first enabled one, takes the focus.
 */
export function focusFirstInvalid(root: HTMLElement | null): void {
  const target = root?.querySelector<HTMLElement>(
    "[aria-invalid='true'], [data-invalid='true']",
  );
  if (!target) return;
  if (target.dataset.invalid !== "true") {
    target.focus();
    return;
  }
  const radio =
    target.querySelector<HTMLInputElement>(
      "input[type='radio']:checked:not(:disabled)",
    ) ?? target.querySelector<HTMLInputElement>("input[type='radio']:not(:disabled)");
  radio?.focus();
}

/** A trigger that asks for nothing: not yet submitted (0), no state, or no field errors ({}). */
function isIdle(trigger: unknown): boolean {
  if (trigger === undefined || trigger === null || trigger === 0) return true;
  return typeof trigger === "object" && Object.keys(trigger).length === 0;
}

/**
 * Moves focus to the first invalid field of the form each time `trigger` changes (a submit count,
 * or a new set of field errors), so a keyboard or screen reader user lands on what needs fixing
 * (its error is read through aria-describedby). Never on other re-renders, so live re-validation
 * while the teacher types does not move focus.
 */
export function useFocusFirstInvalid(
  form: RefObject<HTMLFormElement | null>,
  trigger: unknown,
): void {
  useEffect(() => {
    if (isIdle(trigger)) return;
    focusFirstInvalid(form.current);
  }, [form, trigger]);
}
