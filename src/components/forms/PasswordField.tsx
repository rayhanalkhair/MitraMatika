"use client";

import { Eye, EyeOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import { bindingProps, type FieldBinding } from "./binding";
import { describedBy, inputClass } from "./field-styles";

/**
 * A labelled password input with a show/hide toggle. The toggle keeps one name ("Show password")
 * and reports its state with aria-pressed. The error (already translated) and the hint are tied
 * to the input with aria-describedby.
 */
export function PasswordField({
  id,
  label,
  autoComplete,
  hint,
  error,
  labelAside,
  ...binding
}: {
  id: string;
  label: string;
  autoComplete: "new-password" | "current-password";
  hint?: string;
  error?: string;
  /** Shown at the end of the label row (the "forgot password?" link). */
  labelAside?: ReactNode;
} & FieldBinding) {
  const t = useTranslations("auth.fields");
  const [visible, setVisible] = useState(false);
  const errorId = error ? `${id}-error` : undefined;
  const hintId = hint ? `${id}-hint` : undefined;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3">
        <label htmlFor={id} className="font-heading text-sm font-semibold">
          {label}
        </label>
        {labelAside}
      </div>
      <div className="relative">
        <input
          id={id}
          {...bindingProps(binding)}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(errorId, hintId)}
          className={`${inputClass} pr-13`}
        />
        <button
          type="button"
          aria-pressed={visible}
          aria-controls={id}
          aria-label={t("showPassword")}
          onClick={() => {
            setVisible((shown) => !shown);
          }}
          className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-lg text-muted-foreground transition-colors duration-150 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {visible ? (
            <EyeOff aria-hidden="true" className="size-5" />
          ) : (
            <Eye aria-hidden="true" className="size-5" />
          )}
        </button>
      </div>
      {error && (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      )}
      {hint && (
        <p id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}
