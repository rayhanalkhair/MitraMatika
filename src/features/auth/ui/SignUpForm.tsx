"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { signUpAction } from "@/features/auth/actions/sign-up";
import {
  fieldErrorKey,
  type SignUpField,
  type SignUpState,
} from "@/features/auth/schema/auth-forms";
import { signUpFormSchema } from "@/features/auth/schema/sign-up";
import { describedBy } from "@/components/forms/field-styles";
import { FormError } from "@/components/forms/FormError";
import { PasswordField } from "@/components/forms/PasswordField";
import { SubmitButton } from "@/components/forms/SubmitButton";
import { TextField } from "@/components/forms/TextField";
import { formDataOf } from "@/lib/forms/form-data";
import { useActionForm } from "@/lib/forms/use-action-form";

const INITIAL_STATE: SignUpState = {};

/**
 * Validated in the browser with React Hook Form over `signUpFormSchema`; the Server Action parses
 * the same FormData with the same schema. Works without JavaScript too (decision 4): the form keeps
 * `action={formAction}`, and the server render of a refused post shows the action's errors and the
 * typed values (never the passwords).
 */
export function SignUpForm() {
  const t = useTranslations("auth");
  const { form, formRef, state, formAction, pending, onSubmit } = useActionForm({
    schema: signUpFormSchema,
    // A refused post without JavaScript renders with what was typed (never the passwords).
    defaultValues: ({ values }) => ({
      name: values?.name ?? "",
      email: values?.email ?? "",
      password: "",
      confirmPassword: "",
      schoolName: values?.schoolName ?? "",
      acceptPrivacy: values?.acceptPrivacy === "on",
    }),
    action: signUpAction,
    initialState: INITIAL_STATE,
    toPayload: (_values, element) => formDataOf(element),
    fieldErrorsOf: (current) => current.fieldErrors,
    dependentFields: { password: ["confirmPassword"] },
  });
  const { register } = form;
  // React Hook Form fills the fields only once JavaScript runs: the server render takes the same
  // starting values as attributes. With JavaScript the fields keep what was typed (never reset).
  const { errors, defaultValues: typed } = form.formState;

  const fieldError = (field: SignUpField) => {
    const message = errors[field]?.message;
    return message ? t(`fieldErrors.${fieldErrorKey(message)}`) : undefined;
  };
  const privacyError = fieldError("acceptPrivacy");

  return (
    <form
      ref={formRef}
      action={formAction}
      onSubmit={onSubmit}
      noValidate
      className="flex flex-col gap-4"
    >
      <TextField
        id="sign-up-name"
        label={t("fields.name")}
        autoComplete="name"
        registration={register("name")}
        defaultValue={typed?.name}
        error={fieldError("name")}
      />
      <TextField
        id="sign-up-email"
        type="email"
        label={t("fields.email")}
        autoComplete="email"
        registration={register("email")}
        defaultValue={typed?.email}
        error={fieldError("email")}
      />
      <PasswordField
        id="sign-up-password"
        label={t("fields.password")}
        autoComplete="new-password"
        hint={t("fields.passwordHint")}
        registration={register("password")}
        error={fieldError("password")}
      />
      <PasswordField
        id="sign-up-confirm-password"
        label={t("fields.confirmPassword")}
        autoComplete="new-password"
        registration={register("confirmPassword")}
        error={fieldError("confirmPassword")}
      />
      <TextField
        id="sign-up-school"
        label={t("fields.schoolName")}
        autoComplete="organization"
        registration={register("schoolName")}
        defaultValue={typed?.schoolName}
        error={fieldError("schoolName")}
      />
      <div className="flex flex-col gap-2">
        {/* The whole row is the label: a 44 px target around the 24 px box. */}
        <label
          data-slot="privacy-target"
          className="flex min-h-11 cursor-pointer items-start gap-3"
        >
          <input
            id="sign-up-privacy"
            {...register("acceptPrivacy")}
            type="checkbox"
            defaultChecked={typed?.acceptPrivacy}
            aria-invalid={privacyError ? true : undefined}
            aria-describedby={describedBy(
              privacyError ? "sign-up-privacy-error" : undefined,
            )}
            className="mt-2.5 size-6 shrink-0 accent-primary"
          />
          <span className="py-2 text-sm leading-6">
            {t.rich("signUp.privacy", {
              link: (chunks) => (
                <Link
                  href="/privacy"
                  className="font-semibold text-primary underline underline-offset-4"
                >
                  {chunks}
                </Link>
              ),
            })}
          </span>
        </label>
        {privacyError && (
          <p id="sign-up-privacy-error" className="text-sm text-destructive">
            {privacyError}
          </p>
        )}
      </div>
      <FormError message={state.error ? t(`formErrors.${state.error}`) : undefined} />
      <SubmitButton
        pending={pending}
        label={t("signUp.submit")}
        pendingLabel={t("working")}
      />
    </form>
  );
}
