"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, useState, type SyntheticEvent } from "react";
import { resendVerificationAction } from "@/features/auth/actions/verify-email";
import {
  parseEmailForm,
  RESEND_COOLDOWN_SECONDS,
  type EmailField,
  type EmailFormState,
  type FieldErrors,
} from "@/features/auth/schema/auth-forms";
import { submitClass } from "@/components/forms/field-styles";
import { TextField } from "@/components/forms/TextField";
import { useFocusFirstInvalid } from "@/lib/forms/focus-first-invalid";

/**
 * The resend form of /verify-email. The answer to a resend is the same for every address, so it
 * never tells whether one has an account. After each accepted resend (and right after sign-up,
 * through `initialCooldown`) the button stays disabled for 60 seconds with a visible countdown.
 */
export function VerifyEmailNotice({
  defaultEmail,
  initialCooldown,
}: {
  defaultEmail: string;
  initialCooldown: number;
}) {
  const t = useTranslations("auth");
  const [state, formAction, pending] = useActionState<EmailFormState, FormData>(
    resendVerificationAction,
    {},
  );
  const [clientErrors, setClientErrors] = useState<FieldErrors<EmailField> | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const errors = clientErrors ?? state.fieldErrors;
  useFocusFirstInvalid(formRef, errors);

  const [remaining, setRemaining] = useState(initialCooldown);
  const [countedFrom, setCountedFrom] = useState(state.sentAt);
  if (state.sentAt !== countedFrom) {
    setCountedFrom(state.sentAt);
    if (state.sentAt !== undefined) setRemaining(RESEND_COOLDOWN_SECONDS);
  }
  useEffect(() => {
    if (remaining <= 0) return;
    const timer = setTimeout(() => {
      setRemaining((seconds) => seconds - 1);
    }, 1000);
    return () => {
      clearTimeout(timer);
    };
  }, [remaining]);

  function validate(event: SyntheticEvent<HTMLFormElement>) {
    const parsed = parseEmailForm(new FormData(event.currentTarget));
    if (parsed.ok) {
      setClientErrors(null);
      return;
    }
    event.preventDefault();
    setClientErrors(parsed.error);
  }

  const emailError = errors?.email ? t(`fieldErrors.${errors.email}`) : undefined;
  const waiting = remaining > 0;

  return (
    <form
      ref={formRef}
      action={formAction}
      onSubmit={validate}
      noValidate
      className="flex flex-col gap-4"
    >
      <p className="text-sm text-muted-foreground">{t("verify.approvalNote")}</p>
      <p className="text-sm text-muted-foreground">{t("verify.resendHint")}</p>
      <TextField
        id="verify-email"
        name="email"
        type="email"
        label={t("fields.email")}
        autoComplete="email"
        defaultValue={state.values?.email ?? defaultEmail}
        error={emailError}
      />
      <p role="status" className="text-sm text-success-foreground">
        {state.sentAt !== undefined ? t("verify.sent") : ""}
      </p>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {t(`formErrors.${state.error}`)}
        </p>
      )}
      <button
        type="submit"
        disabled={pending || waiting}
        aria-busy={pending}
        className={submitClass}
      >
        {waiting ? t("verify.resendIn", { seconds: remaining }) : t("verify.resend")}
      </button>
    </form>
  );
}
