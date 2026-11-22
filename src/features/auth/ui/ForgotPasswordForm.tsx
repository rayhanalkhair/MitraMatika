"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, useState, type SyntheticEvent } from "react";
import { requestPasswordResetAction } from "@/features/auth/actions/forgot-password";
import {
  parseEmailForm,
  type EmailField,
  type EmailFormState,
  type FieldErrors,
} from "@/features/auth/schema/auth-forms";
import { submitClass } from "@/components/forms/field-styles";
import { TextField } from "@/components/forms/TextField";
import { useFocusFirstInvalid } from "@/lib/forms/focus-first-invalid";

/**
 * Asks for the address and then shows one confirmation, the same for every address (it never
 * says whether an account exists, and does not repeat the address).
 */
export function ForgotPasswordForm() {
  const t = useTranslations("auth");
  const [state, formAction, pending] = useActionState<EmailFormState, FormData>(
    requestPasswordResetAction,
    {},
  );
  const [clientErrors, setClientErrors] = useState<FieldErrors<EmailField> | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const confirmationRef = useRef<HTMLParagraphElement>(null);
  const errors = clientErrors ?? state.fieldErrors;
  useFocusFirstInvalid(formRef, errors);
  const sent = state.sentAt !== undefined;

  useEffect(() => {
    if (sent) confirmationRef.current?.focus();
  }, [sent]);

  function validate(event: SyntheticEvent<HTMLFormElement>) {
    const parsed = parseEmailForm(new FormData(event.currentTarget));
    if (parsed.ok) {
      setClientErrors(null);
      return;
    }
    event.preventDefault();
    setClientErrors(parsed.error);
  }

  if (sent) {
    return (
      <p
        ref={confirmationRef}
        role="status"
        tabIndex={-1}
        className="rounded-lg border border-success/40 bg-success-soft p-4 text-sm text-success-foreground focus-visible:outline-none"
      >
        {t("forgot.sent")}
      </p>
    );
  }

  return (
    <form
      ref={formRef}
      action={formAction}
      onSubmit={validate}
      noValidate
      className="flex flex-col gap-4"
    >
      <TextField
        id="forgot-email"
        name="email"
        type="email"
        label={t("fields.email")}
        autoComplete="email"
        defaultValue={state.values?.email}
        error={errors?.email ? t(`fieldErrors.${errors.email}`) : undefined}
      />
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {t(`formErrors.${state.error}`)}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        aria-busy={pending}
        className={submitClass}
      >
        {pending ? t("working") : t("forgot.submit")}
      </button>
    </form>
  );
}
