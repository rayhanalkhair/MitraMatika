"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useActionState, useRef, useState, type SyntheticEvent } from "react";
import { signInAction } from "@/features/auth/actions/sign-in";
import {
  parseSignInForm,
  type FieldErrors,
  type SignInField,
  type SignInState,
} from "@/features/auth/schema/auth-forms";
import { linkClass, submitClass } from "@/components/forms/field-styles";
import { PasswordField } from "@/components/forms/PasswordField";
import { TextField } from "@/components/forms/TextField";
import { useFocusFirstInvalid } from "@/lib/forms/focus-first-invalid";

export function SignInForm() {
  const t = useTranslations("auth");
  const [state, formAction, pending] = useActionState<SignInState, FormData>(
    signInAction,
    {},
  );
  const [clientErrors, setClientErrors] = useState<FieldErrors<SignInField> | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const errors = clientErrors ?? state.fieldErrors;
  useFocusFirstInvalid(formRef, errors);

  // Checked here first so the errors show without a round trip; the action checks again.
  function validate(event: SyntheticEvent<HTMLFormElement>) {
    const parsed = parseSignInForm(new FormData(event.currentTarget));
    if (parsed.ok) {
      setClientErrors(null);
      return;
    }
    event.preventDefault();
    setClientErrors(parsed.error);
  }

  const fieldError = (field: SignInField) => {
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
      <TextField
        id="sign-in-email"
        name="email"
        type="email"
        label={t("fields.email")}
        autoComplete="email"
        defaultValue={state.values?.email}
        error={fieldError("email")}
      />
      <PasswordField
        id="sign-in-password"
        name="password"
        label={t("fields.password")}
        autoComplete="current-password"
        error={fieldError("password")}
        labelAside={
          <Link href="/forgot-password" className={`${linkClass} text-sm`}>
            {t("signIn.forgotPassword")}
          </Link>
        }
      />
      {state.error && (
        <div role="alert" className="flex flex-col gap-1 text-sm text-destructive">
          <p>{t(`formErrors.${state.error}`)}</p>
          {state.error === "emailNotVerified" && (
            <Link href="/verify-email" className={linkClass}>
              {t("signIn.resendLink")}
            </Link>
          )}
        </div>
      )}
      <button
        type="submit"
        disabled={pending}
        aria-busy={pending}
        className={submitClass}
      >
        {pending ? t("working") : t("signIn.submit")}
      </button>
    </form>
  );
}
