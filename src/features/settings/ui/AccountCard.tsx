"use client";

import { useTranslations } from "next-intl";
import { useActionState, useId, useRef } from "react";
import type { AccountSettings, ProfileField, ProfileFormState } from "@/features/auth";
import { submitClass } from "@/components/forms/field-styles";
import { TextField } from "@/components/forms/TextField";
import { useFocusFirstInvalid } from "@/lib/forms/focus-first-invalid";
import { updateProfileAction } from "@/features/settings/actions/update-profile";
import { accountSectionClass } from "./account-styles";
import { ChangePasswordForm } from "./ChangePasswordForm";
import { DeleteAccountDialog } from "./DeleteAccountDialog";

/** The name and school form; the user id comes from the session in the Server Action. */
function ProfileForm({ account }: { account: AccountSettings }) {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState<ProfileFormState, FormData>(
    updateProfileAction,
    {},
  );
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstInvalid(formRef, state.fieldErrors);
  const headingId = useId();

  const fieldError = (field: ProfileField) => {
    const key = state.fieldErrors?.[field];
    return key ? t(`auth.fieldErrors.${key}`) : undefined;
  };

  return (
    <section aria-labelledby={headingId} className={accountSectionClass}>
      <h3 id={headingId} className="font-heading text-base font-semibold">
        {t("settings.account.profile.heading")}
      </h3>
      <form ref={formRef} action={formAction} noValidate className="flex flex-col gap-4">
        <TextField
          id="account-name"
          name="name"
          label={t("auth.fields.name")}
          autoComplete="name"
          defaultValue={state.values?.name ?? account.name}
          error={fieldError("name")}
        />
        <TextField
          id="account-school"
          name="schoolName"
          label={t("auth.fields.schoolName")}
          autoComplete="organization"
          defaultValue={state.values?.schoolName ?? account.schoolName ?? ""}
          error={fieldError("schoolName")}
        />
        {state.error && (
          <p role="alert" className="text-sm text-destructive">
            {t(`settings.account.formErrors.${state.error}`)}
          </p>
        )}
        <p role="status" className="text-sm text-muted-foreground empty:hidden">
          {state.savedAt !== undefined && !pending
            ? t("settings.account.profile.saved")
            : ""}
        </p>
        <button
          type="submit"
          disabled={pending}
          aria-busy={pending}
          className={`${submitClass} sm:w-auto sm:self-start`}
        >
          {pending ? t("auth.working") : t("settings.account.profile.submit")}
        </button>
      </form>
    </section>
  );
}

/**
 * Settings > Akun (decision 9): the account email, the name and school form, the password change
 * (password accounts only) and account deletion. Takes plain data only, so it can sit under the
 * server page.
 */
export function AccountCard({ account }: { account: AccountSettings }) {
  const t = useTranslations("settings.account");
  const headingId = useId();
  const descriptionId = useId();
  return (
    <section
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      className="flex min-w-0 flex-col gap-5 rounded-lg border border-border bg-card p-5 shadow-card"
    >
      <div className="flex flex-col gap-2">
        <h2 id={headingId} className="font-heading text-lg font-bold">
          {t("heading")}
        </h2>
        <p id={descriptionId} className="text-sm text-muted-foreground">
          {t("description")}
        </p>
        <dl className="flex flex-col gap-1 text-sm">
          <dt className="font-heading font-semibold">{t("emailLabel")}</dt>
          <dd className="break-all">{account.email}</dd>
        </dl>
      </div>
      <ProfileForm account={account} />
      {/* Google-only accounts have no password to change; they set one through the reset flow. */}
      {account.hasPassword && <ChangePasswordForm />}
      <DeleteAccountDialog email={account.email} hasPassword={account.hasPassword} />
    </section>
  );
}

/** The card when the account could not be read: no form that could overwrite it with blanks. */
export function AccountCardUnavailable() {
  const t = useTranslations("settings.account");
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-5 shadow-card"
    >
      <h2 id={headingId} className="font-heading text-lg font-bold">
        {t("heading")}
      </h2>
      <p role="alert" className="text-sm text-destructive">
        {t("loadFailed")}
      </p>
    </section>
  );
}
