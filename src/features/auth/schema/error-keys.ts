import { hasMessageKey } from "@/lib/i18n/translator";
import type { AuthErrorKey, AuthNoticeKey } from "./types";

// True for a string that names a sign-in error message (the /sign-in page reads it from ?error=).
export function isAuthErrorKey(value: string): value is AuthErrorKey {
  return hasMessageKey("auth.errors", value);
}

// True for a string that names a sign-in notice (the /sign-in page reads it from ?notice=).
export function isAuthNoticeKey(value: string): value is AuthNoticeKey {
  return hasMessageKey("auth.notices", value);
}
