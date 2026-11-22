import { bindingProps, type FieldBinding } from "./binding";
import { Field } from "./Field";
import { inputClass } from "./field-styles";

/** A labelled text input; the error (already translated) is tied to it with aria-describedby. */
export function TextField({
  id,
  label,
  type = "text",
  autoComplete,
  hint,
  maxLength,
  error,
  ...binding
}: {
  id: string;
  label: string;
  type?: "text" | "email";
  autoComplete: string;
  hint?: string;
  maxLength?: number;
  error?: string;
} & FieldBinding) {
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      {(a11y) => (
        <input
          id={id}
          {...bindingProps(binding)}
          type={type}
          autoComplete={autoComplete}
          maxLength={maxLength}
          spellCheck={type === "email" ? false : undefined}
          {...a11y}
          className={inputClass}
        />
      )}
    </Field>
  );
}
