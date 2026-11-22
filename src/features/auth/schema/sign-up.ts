import { z } from "zod";
import { checkPassword, type PasswordProblem } from "../service/password-policy";

// Decision 1. Issue messages are keys for the form (Task 5 maps them to copy).
export const NAME_MIN = 2;
export const NAME_MAX = 80;
export const SCHOOL_NAME_MAX = 120;

const PASSWORD_ISSUE: Record<PasswordProblem, string> = {
  tooShort: "passwordTooShort",
  tooLong: "passwordTooLong",
  needsLetterAndDigit: "passwordNeedsLetterAndDigit",
};

// The longest address SMTP allows (RFC 5321 path limit).
export const EMAIL_MAX = 254;

/** One account per address: always trimmed and lower-cased before anything else sees it. */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: "emailInvalid" }).max(EMAIL_MAX, { message: "emailInvalid" }));

export const nameSchema = z
  .string()
  .trim()
  .min(NAME_MIN, { message: "nameLength" })
  .max(NAME_MAX, { message: "nameLength" });

const schoolNameText = z
  .string()
  .trim()
  .max(SCHOOL_NAME_MAX, { message: "schoolNameTooLong" });
const blankAsNone = (value: string | undefined) => (value === "" ? undefined : value);

/** Optional; blank means none. */
export const schoolNameSchema = schoolNameText.optional().transform(blankAsNone);

export const passwordSchema = z.string().superRefine((password, ctx) => {
  const result = checkPassword(password);
  if (!result.ok) ctx.addIssue({ code: "custom", message: PASSWORD_ISSUE[result.error] });
});

const signUpFields = z.object({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
  confirmPassword: z.string(),
  // The form always posts the field; blank means no school.
  schoolName: schoolNameText.transform(blankAsNone),
  acceptPrivacy: z
    .boolean({ message: "privacyRequired" })
    .refine((accepted) => accepted, { message: "privacyRequired" }),
});

/**
 * The sign-up form (decision 5 of the stack-alignment plan): the raw form values in (strings, the
 * privacy checkbox as a boolean), the sign-up out. React Hook Form's resolver validates with it in
 * the browser and the Server Action parses the same values with it again (the check that counts).
 */
export const signUpFormSchema = signUpFields
  .refine((form) => form.password === form.confirmPassword, {
    path: ["confirmPassword"],
    message: "passwordMismatch",
    // zod skips an object's refinements once a field has a type issue (a consent that was not
    // posted as a boolean); this one only needs the two strings, so a mismatch always shows
    // together with every other field error.
    when: ({ value }) => {
      if (typeof value !== "object" || value === null) return false;
      const form = value as Partial<Record<"password" | "confirmPassword", unknown>>;
      return (
        typeof form.password === "string" && typeof form.confirmPassword === "string"
      );
    },
  })
  .transform(({ name, email, password, schoolName }) => ({
    name,
    email,
    password,
    schoolName,
  }));

export type SignUpFormValues = z.input<typeof signUpFormSchema>;
export type SignUpInput = z.output<typeof signUpFormSchema>;
