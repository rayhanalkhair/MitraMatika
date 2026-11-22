"use client";

import { useTranslations } from "next-intl";
import { useActionState, useId, useRef } from "react";
import type { ChangePasswordField, ChangePasswordState } from "@/features/auth";
import { submitClass } from "@/components/forms/field-styles";
import { PasswordField } from "@/components/forms/PasswordField";
import { useFocusFirstInvalid } from "@/lib/forms/focus-first-invalid";
import { changePasswordAction } from "@/features/settings/actions/change-password";
import { accountSectionClass } from "./account-styles";

/**
 * The password change (decision 9), shown only to accounts that have a password. Needs the current
 * password; the new one follows the sign-up policy. Other devices are signed out, this one stays.
 * After a save the form is reset (React clears an uncontrolled form after its action), so no
 * password stays in the fields.
 */
export function ChangePasswordForm() {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState<ChangePasswordState, FormData>(
    changePasswordAction,
    {},
  );
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstInvalid(formRef, state.fieldErrors);
  const headingId = useId();
  const descriptionId = useId();

  const fieldError = (field: ChangePasswordField) => {
    const key = state.fieldErrors?.[field];
    if (!key) return undefined;
    return key === "wrongPassword"
      ? t("settings.account.password.wrongPassword")
      : t(`auth.fieldErrors.${key}`);
  };

  return (
    <section
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      className={accountSectionClass}
    >
      <h3 id={headingId} className="font-heading text-base font-semibold">
        {t("settings.account.password.heading")}
      </h3>
      <p id={descriptionId} className="text-sm text-muted-foreground">
        {t("settings.account.password.description")}
      </p>
      <form ref={formRef} action={formAction} noValidate className="flex flex-col gap-4">
        <PasswordField
          id="account-current-password"
          name="currentPassword"
          label={t("settings.account.password.current")}
          autoComplete="current-password"
          error={fieldError("currentPassword")}
        />
        <PasswordField
          id="account-new-password"
          name="newPassword"
          label={t("auth.fields.newPassword")}
          autoComplete="new-password"
          hint={t("auth.fields.passwordHint")}
          error={fieldError("newPassword")}
        />
        <PasswordField
          id="account-confirm-password"
          name="confirmPassword"
          label={t("auth.fields.confirmPassword")}
          autoComplete="new-password"
          error={fieldError("confirmPassword")}
        />
        {state.error && (
          <p role="alert" className="text-sm text-destructive">
            {t(`settings.account.formErrors.${state.error}`)}
          </p>
        )}
        <p role="status" className="text-sm text-muted-foreground empty:hidden">
          {state.savedAt !== undefined && !pending
            ? t("settings.account.password.saved")
            : ""}
        </p>
        <button
          type="submit"
          disabled={pending}
          aria-busy={pending}
          className={`${submitClass} sm:w-auto sm:self-start`}
        >
          {pending ? t("auth.working") : t("settings.account.password.submit")}
        </button>
      </form>
    </section>
  );
}
