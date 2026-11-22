import { err, ok, type Result } from "@/lib/result";

// Decision 2: 8 to 128 characters with at least one letter and one digit. Better Auth checks the
// length itself (minPasswordLength/maxPasswordLength); the letter-and-digit rule is applied by
// the auth server's pre-request hook and by the sign-up form schema.
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export type PasswordProblem = "tooShort" | "tooLong" | "needsLetterAndDigit";

export function checkPassword(password: string): Result<void, PasswordProblem> {
  // Characters, not UTF-16 code units, so an emoji counts once.
  const length = Array.from(password).length;
  if (length < PASSWORD_MIN) return err("tooShort");
  if (length > PASSWORD_MAX) return err("tooLong");
  if (!/\p{L}/u.test(password) || !/\p{Nd}/u.test(password)) {
    return err("needsLetterAndDigit");
  }
  return ok();
}
