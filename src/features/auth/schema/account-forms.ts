import { z } from "zod";
import { ok, type Result } from "@/lib/result";
import {
  formText,
  parseWith,
  withMismatch,
  type FieldErrorKey,
  type FieldErrors,
} from "./auth-forms";
import { nameSchema, passwordSchema, schoolNameSchema } from "./sign-up";

// The account settings forms (Settings > Akun, decision 9). Read in the Server Actions with these
// parsers; the field rules are the sign-up rules (sign-up.ts), so both can never disagree.

/** A form-level message of the account forms (settings.account.formErrors). */
export type AccountFormErrorKey =
  | "generic"
  | "rateLimited"
  | "unauthenticated"
  /** Account deletion without a password needs a session from the last 10 minutes. */
  | "signInAgain";

export interface AccountFormState<F extends string, K extends string = FieldErrorKey> {
  error?: AccountFormErrorKey;
  fieldErrors?: Partial<Record<F, K>>;
  /** What the user typed, so a failed submit keeps it. Never a password. */
  values?: Partial<Record<F, string>>;
  /** When the last save succeeded. */
  savedAt?: number;
}

export type ProfileField = "name" | "schoolName";
export type ProfileFormState = AccountFormState<ProfileField>;

const profileSchema = z.object({ name: nameSchema, schoolName: schoolNameSchema });

/** The trimmed name (2 to 80 characters) and school (up to 120; blank means none). */
export function parseProfileForm(
  data: FormData,
): Result<{ name: string; schoolName: string | null }, FieldErrors<ProfileField>> {
  const parsed = parseWith(profileSchema, {
    name: formText(data, "name"),
    schoolName: formText(data, "schoolName"),
  });
  if (!parsed.ok) return parsed;
  return ok({ name: parsed.data.name, schoolName: parsed.data.schoolName ?? null });
}

export type ChangePasswordField = "currentPassword" | "newPassword" | "confirmPassword";
/** The field messages of the password change: the sign-up ones, plus a wrong current password. */
export type ChangePasswordErrorKey = FieldErrorKey | "wrongPassword";
export type ChangePasswordState = AccountFormState<
  ChangePasswordField,
  ChangePasswordErrorKey
>;

const changePasswordSchema = z
  .object({
    // Any password the account may have: the policy applies to the new one only.
    currentPassword: z.string().min(1, { message: "passwordRequired" }),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((form) => form.newPassword === form.confirmPassword, {
    path: ["confirmPassword"],
    message: "passwordMismatch",
  });

/** The current password (required) and the new one (policy, typed twice). */
export function parseChangePasswordForm(
  data: FormData,
): Result<
  { currentPassword: string; newPassword: string },
  FieldErrors<ChangePasswordField>
> {
  const newPassword = formText(data, "newPassword");
  const confirmPassword = formText(data, "confirmPassword");
  const parsed = withMismatch(
    parseWith(changePasswordSchema, {
      currentPassword: formText(data, "currentPassword"),
      newPassword,
      confirmPassword,
    }),
    newPassword,
    confirmPassword,
    "confirmPassword",
  );
  if (!parsed.ok) return parsed;
  return ok({
    currentPassword: parsed.data.currentPassword,
    newPassword: parsed.data.newPassword,
  });
}

export type DeleteAccountField = "confirmEmail" | "currentPassword";
export type DeleteAccountErrorKey =
  "emailMismatch" | "wrongPassword" | "passwordRequired";
export type DeleteAccountState = AccountFormState<
  DeleteAccountField,
  DeleteAccountErrorKey
>;
