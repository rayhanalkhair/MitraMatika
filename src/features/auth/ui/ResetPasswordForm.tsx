"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useActionState, useRef, useState, type SyntheticEvent } from "react";
import { resetPasswordAction } from "@/features/auth/actions/reset-password";
import {
  parseResetPasswordForm,
  type FieldErrors,
  type ResetPasswordField,
  type ResetPasswordState,
} from "@/features/auth/schema/auth-forms";
import { linkClass, submitClass } from "@/components/forms/field-styles";
import { PasswordField } from "@/components/forms/PasswordField";
import { useFocusFirstInvalid } from "@/lib/forms/focus-first-invalid";

/** The expired or used-up reset link, with the way to ask for a new one. */
export function ResetLinkExpired() {
  const t = useTranslations("auth.reset");
  return (
    <div role="alert" className="flex flex-col gap-2 text-sm">
      <p>{t("expired")}</p>
      <Link href="/forgot-password" className={linkClass}>
        {t("requestNew")}
      </Link>
    </div>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const t = useTranslations("auth");
  const [state, formAction, pending] = useActionState<ResetPasswordState, FormData>(
    resetPasswordAction,
    {},
  );
  const [clientErrors, setClientErrors] =
    useState<FieldErrors<ResetPasswordField> | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const errors = clientErrors ?? state.fieldErrors;
  useFocusFirstInvalid(formRef, errors);

  function validate(event: SyntheticEvent<HTMLFormElement>) {
    const parsed = parseResetPasswordForm(new FormData(event.currentTarget));
    if (parsed.ok) {
      setClientErrors(null);
      return;
    }
    event.preventDefault();
    setClientErrors(parsed.error);
  }

  if (state.expired) return <ResetLinkExpired />;

  const fieldError = (field: ResetPasswordField) => {
    const key = errors?.[field];
    return key ? t(`fieldErrors.${key}`) : undefined;
  };

  return (
    <form
      ref={formRef}
      action={formAction}
      onSubmit={validate}
      noValidate
      className="flex flex-col gap-4"
    >
      <input type="hidden" name="token" value={token} />
      <PasswordField
        id="reset-password"
        name="password"
        label={t("fields.newPassword")}
        autoComplete="new-password"
        hint={t("fields.passwordHint")}
        error={fieldError("password")}
      />
      <PasswordField
        id="reset-confirm-password"
        name="confirmPassword"
        label={t("fields.confirmPassword")}
        autoComplete="new-password"
        error={fieldError("confirmPassword")}
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
        {pending ? t("working") : t("reset.submit")}
      </button>
    </form>
  );
}
