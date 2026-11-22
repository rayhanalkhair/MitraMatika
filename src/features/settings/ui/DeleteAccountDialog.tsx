"use client";

import { useTranslations } from "next-intl";
import {
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";
import type { DeleteAccountState } from "@/features/auth";
import { signOutAction } from "@/features/auth/actions/actions";
import { describedBy, inputClass } from "@/components/forms/field-styles";
import { PasswordField } from "@/components/forms/PasswordField";
import { deleteAccountAction } from "@/features/settings/actions/delete-account";
import { emailConfirmationMatches } from "../schema/delete-confirmation";
import { accountSectionClass } from "./account-styles";

const dangerButtonClass =
  "inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-destructive px-6 font-heading text-base font-semibold text-white transition-colors duration-150 hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60";
const secondaryButtonClass =
  "inline-flex min-h-12 items-center justify-center rounded-lg border border-border bg-card px-6 font-heading text-base font-semibold transition-colors duration-150 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60";

/**
 * Account deletion (decision 9): a modal dialog (native <dialog>: focus stays inside, Escape
 * closes) that asks for the account's address, typed exactly, and a fresh credential (ruling S11):
 * the current password, or for an account without one a recent sign-in. The Server Action checks
 * everything again against the session, deletes everything and signs out.
 */
export function DeleteAccountDialog({
  email,
  hasPassword,
}: {
  email: string;
  hasPassword: boolean;
}) {
  const t = useTranslations("settings.account.delete");
  // Each opening starts a fresh form: no error from an earlier attempt shows again.
  const [opening, setOpening] = useState(0);
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className={accountSectionClass}>
      <h3 id={headingId} className="font-heading text-base font-semibold">
        {t("heading")}
      </h3>
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      <button
        ref={openerRef}
        type="button"
        onClick={() => {
          setOpening((n) => n + 1);
          setOpen(true);
        }}
        className={`${dangerButtonClass} w-full sm:w-auto sm:self-start`}
      >
        {t("open")}
      </button>
      {open && (
        <DeleteAccountForm
          key={opening}
          email={email}
          hasPassword={hasPassword}
          onClosed={() => {
            setOpen(false);
            openerRef.current?.focus();
          }}
        />
      )}
    </section>
  );
}

function DeleteAccountForm({
  email,
  hasPassword,
  onClosed,
}: {
  email: string;
  hasPassword: boolean;
  onClosed: () => void;
}) {
  const t = useTranslations();
  const [mismatch, setMismatch] = useState(false);
  const [state, formAction, pending] = useActionState<DeleteAccountState, FormData>(
    deleteAccountAction,
    {},
  );
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();

  useEffect(() => {
    dialogRef.current?.showModal();
    inputRef.current?.focus();
  }, []);

  // A server-side error lands on its field like a client-side one.
  useEffect(() => {
    if (state.fieldErrors?.confirmEmail) inputRef.current?.focus();
    else if (state.fieldErrors?.currentPassword) {
      formRef.current?.querySelector<HTMLElement>("#delete-account-password")?.focus();
    }
  }, [state.fieldErrors]);

  function validate(event: SyntheticEvent<HTMLFormElement>) {
    const typed = new FormData(event.currentTarget).get("confirmEmail");
    if (typeof typed === "string" && emailConfirmationMatches(typed, email)) {
      setMismatch(false);
      return;
    }
    event.preventDefault();
    setMismatch(true);
    inputRef.current?.focus();
  }

  const showMismatch = mismatch || state.fieldErrors?.confirmEmail !== undefined;
  const passwordError = state.fieldErrors?.currentPassword;
  let passwordMessage: string | undefined;
  if (passwordError === "wrongPassword") {
    passwordMessage = t("settings.account.password.wrongPassword");
  } else if (passwordError === "passwordRequired") {
    passwordMessage = t("auth.fieldErrors.passwordRequired");
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onClose={onClosed}
      // Escape must not close it while the deletion is running.
      onCancel={(event) => {
        if (pending) event.preventDefault();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border border-border bg-card p-5 text-foreground shadow-card backdrop:bg-black/50"
    >
      <form
        ref={formRef}
        action={formAction}
        onSubmit={validate}
        noValidate
        className="flex flex-col gap-4"
      >
        <h2 id={titleId} className="font-heading text-lg font-bold">
          {t("settings.account.delete.dialogTitle")}
        </h2>
        <p id={descriptionId} className="text-sm text-muted-foreground">
          {t("settings.account.delete.dialogDescription")}
        </p>
        <div className="flex flex-col gap-2">
          <label
            htmlFor="delete-account-email"
            className="font-heading text-sm font-semibold break-all"
          >
            {t("settings.account.delete.confirmLabel", { email })}
          </label>
          <input
            ref={inputRef}
            id="delete-account-email"
            name="confirmEmail"
            type="email"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            aria-invalid={showMismatch ? true : undefined}
            aria-describedby={describedBy(
              showMismatch ? errorId : undefined,
              descriptionId,
            )}
            onChange={() => {
              setMismatch(false);
            }}
            className={inputClass}
          />
          {showMismatch && (
            <p id={errorId} className="text-sm text-destructive">
              {t("settings.account.delete.emailMismatch")}
            </p>
          )}
        </div>
        {hasPassword ? (
          <PasswordField
            id="delete-account-password"
            name="currentPassword"
            label={t("settings.account.password.current")}
            autoComplete="current-password"
            hint={t("settings.account.delete.passwordHint")}
            error={passwordMessage}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("settings.account.delete.freshSignIn")}
          </p>
        )}
        {state.error && (
          <p role="alert" className="text-sm text-destructive">
            {t(`settings.account.formErrors.${state.error}`)}
          </p>
        )}
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              dialogRef.current?.close();
            }}
            className={secondaryButtonClass}
          >
            {t("settings.account.delete.cancel")}
          </button>
          <button
            type="submit"
            disabled={pending}
            aria-busy={pending}
            className={dangerButtonClass}
          >
            {pending ? t("auth.working") : t("settings.account.delete.confirm")}
          </button>
        </div>
      </form>
      {state.error === "signInAgain" && (
        <form action={signOutAction} className="mt-3 flex">
          <button type="submit" className={`${secondaryButtonClass} w-full sm:w-auto`}>
            {t("settings.account.delete.signOut")}
          </button>
        </form>
      )}
    </dialog>
  );
}
