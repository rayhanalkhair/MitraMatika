import type { ReactNode } from "react";
import { describedBy } from "./field-styles";

/** The attributes a Field hands its control: the error and hint ids, and the invalid flag. */
export interface FieldA11y {
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

const fieldLabelClass = "font-heading text-sm font-semibold";

/**
 * A labelled control with its hint and error (already translated) tied to it through
 * aria-describedby (error first). The control is rendered by `children` with the attributes to
 * spread, and must use `id`.
 */
export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: (a11y: FieldA11y) => ReactNode;
}) {
  const errorId = error ? `${id}-error` : undefined;
  const hintId = hint ? `${id}-hint` : undefined;
  const a11y: FieldA11y = {};
  const described = describedBy(errorId, hintId);
  if (described) a11y["aria-describedby"] = described;
  if (error) a11y["aria-invalid"] = true;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <label htmlFor={id} className={fieldLabelClass}>
        {label}
      </label>
      {children(a11y)}
      {hint && (
        <p id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
