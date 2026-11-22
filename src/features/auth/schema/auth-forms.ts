import { z } from "zod";
import { err, ok, type Result } from "@/lib/result";
import { text } from "@/lib/forms/form-data";
import {
  emailSchema,
  passwordSchema,
  signUpFormSchema,
  type SignUpFormValues,
  type SignUpInput,
} from "./sign-up";

// The auth forms read FormData with these parsers twice: in the browser before submitting (inline
// errors without a round trip) and again in the Server Action (the only check that counts). The
// sign-up form validates in the browser with React Hook Form's resolver over `signUpFormSchema`
// instead; its action parses the same schema here.

// The per-address limit sends at most one link a minute; the resend button waits as long. Here,
// not in the client component, so the server page can read the number too.
export const RESEND_COOLDOWN_SECONDS = 60;

export const FIELD_ERROR_KEYS = [
  "fieldInvalid",
  "emailInvalid",
  "nameLength",
  "schoolNameTooLong",
  "passwordRequired",
  "passwordTooShort",
  "passwordTooLong",
  "passwordNeedsLetterAndDigit",
  "passwordMismatch",
  "privacyRequired",
] as const;
export type FieldErrorKey = (typeof FIELD_ERROR_KEYS)[number];
export type FieldErrors<F extends string> = Partial<Record<F, FieldErrorKey>>;

/** A form-level message (auth.formErrors). */
export type FormErrorKey =
  "generic" | "rateLimited" | "invalidCredentials" | "emailNotVerified";

export interface AuthFormState<F extends string> {
  error?: FormErrorKey;
  fieldErrors?: FieldErrors<F>;
  /** What the user typed, so a failed submit keeps it. Never a password. */
  values?: Partial<Record<F, string>>;
  /** When the last request was accepted (a link may have been sent). */
  sentAt?: number;
  /** The reset link is invalid, expired or used up. */
  expired?: boolean;
}

export type SignInField = "email" | "password";
export type SignUpField =
  "name" | "email" | "password" | "confirmPassword" | "schoolName" | "acceptPrivacy";
export type EmailField = "email";
export type ResetPasswordField = "password" | "confirmPassword";

export type SignInState = AuthFormState<SignInField>;
export type SignUpState = AuthFormState<SignUpField>;
export type EmailFormState = AuthFormState<EmailField>;
export type ResetPasswordState = AuthFormState<ResetPasswordField>;

const isFieldErrorKey = (value: string): value is FieldErrorKey =>
  (FIELD_ERROR_KEYS as readonly string[]).includes(value);

/** An issue message as a field error key; anything unknown is the generic "fieldInvalid". */
export function fieldErrorKey(message: string | undefined): FieldErrorKey {
  return message !== undefined && isFieldErrorKey(message) ? message : "fieldInvalid";
}

/** A form field as a string; a missing field or a file is empty. */
export function formText(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

// The first issue of each known field, as a message key.
function fieldErrors<F extends string>(
  error: z.ZodError,
  fields: readonly F[],
): FieldErrors<F> {
  const out: FieldErrors<F> = {};
  for (const issue of error.issues) {
    const field = fields.find((name) => name === issue.path[0]);
    if (field === undefined || out[field] !== undefined) continue;
    out[field] = fieldErrorKey(issue.message);
  }
  return out;
}

// zod skips an object's refinements while a field has an issue, so a mismatched confirmation would
// only show after the password is fixed: it is checked here too, so every field shows at once.
export function withMismatch<T, F extends string>(
  result: Result<T, FieldErrors<F>>,
  password: string,
  confirmPassword: string,
  confirmField: F,
): Result<T, FieldErrors<F>> {
  if (result.ok || password === confirmPassword || result.error[confirmField])
    return result;
  return err({ ...result.error, [confirmField]: "passwordMismatch" });
}

export function parseWith<S extends z.ZodType, F extends string>(
  schema: S,
  input: Record<F, unknown>,
): Result<z.output<S>, FieldErrors<F>> {
  const result = schema.safeParse(input);
  if (result.success) return ok(result.data);
  return err(fieldErrors(result.error, Object.keys(input) as F[]));
}

/** The sign-up form's raw values as the browser posted them (the input of `signUpFormSchema`). */
export function signUpFormValues(data: FormData): SignUpFormValues {
  return {
    name: text(data, "name"),
    email: text(data, "email"),
    password: text(data, "password"),
    confirmPassword: text(data, "confirmPassword"),
    schoolName: text(data, "schoolName"),
    // Only the value a checked box posts counts as consent.
    acceptPrivacy: text(data, "acceptPrivacy") === "on",
  };
}

export function parseSignUpForm(
  data: FormData,
): Result<SignUpInput, FieldErrors<SignUpField>> {
  return parseWith(signUpFormSchema, signUpFormValues(data));
}

const signInSchema = z.object({
  email: emailSchema,
  // Any password an account may have: the sign-up policy does not apply to signing in.
  password: z.string().min(1, { message: "passwordRequired" }),
});

export function parseSignInForm(
  data: FormData,
): Result<z.output<typeof signInSchema>, FieldErrors<SignInField>> {
  return parseWith(signInSchema, {
    email: formText(data, "email"),
    password: formText(data, "password"),
  });
}

const emailFormSchema = z.object({ email: emailSchema });

export function parseEmailForm(
  data: FormData,
): Result<z.output<typeof emailFormSchema>, FieldErrors<EmailField>> {
  return parseWith(emailFormSchema, { email: formText(data, "email") });
}

const resetPasswordSchema = z
  .object({ password: passwordSchema, confirmPassword: z.string() })
  .refine((form) => form.password === form.confirmPassword, {
    path: ["confirmPassword"],
    message: "passwordMismatch",
  });

export function parseResetPasswordForm(
  data: FormData,
): Result<{ password: string }, FieldErrors<ResetPasswordField>> {
  const password = formText(data, "password");
  const confirmPassword = formText(data, "confirmPassword");
  const parsed = withMismatch(
    parseWith(resetPasswordSchema, { password, confirmPassword }),
    password,
    confirmPassword,
    "confirmPassword",
  );
  return parsed.ok ? ok({ password: parsed.data.password }) : parsed;
}
