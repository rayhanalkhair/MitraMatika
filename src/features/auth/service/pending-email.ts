import "server-only";
import { cookies } from "next/headers";
import { emailSchema } from "../schema/sign-up";

// The address a sign-up (or an unverified sign-in, or a resend) used, so /verify-email can offer
// the resend without asking for it again. HttpOnly, only sent to /verify-email, gone after 30
// minutes, and cleared once the user is signed in or signs out (a shared computer keeps it for as
// short a time as possible). It is set the same way whether or not the address has an account.
export const PENDING_EMAIL_COOKIE = "mm-pending-email";
export const PENDING_EMAIL_PATH = "/verify-email";
const PENDING_EMAIL_MAX_AGE_SECONDS = 30 * 60;

const cookieOptions = (maxAge: number) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: PENDING_EMAIL_PATH,
  maxAge,
});

export async function rememberPendingEmail(email: string): Promise<void> {
  (await cookies()).set(
    PENDING_EMAIL_COOKIE,
    email,
    cookieOptions(PENDING_EMAIL_MAX_AGE_SECONDS),
  );
}

/** Expires the cookie (on its own path; a plain delete would target "/"). */
export async function forgetPendingEmail(): Promise<void> {
  (await cookies()).set(PENDING_EMAIL_COOKIE, "", cookieOptions(0));
}

/** The same expiry on a response the caller builds itself (a route handler's redirect). */
export function forgetPendingEmailOn(response: {
  cookies: { set(name: string, value: string, options: object): unknown };
}): void {
  response.cookies.set(PENDING_EMAIL_COOKIE, "", cookieOptions(0));
}

/** The remembered address, or undefined when there is none or it is not an address. */
export async function readPendingEmail(): Promise<string | undefined> {
  const value = (await cookies()).get(PENDING_EMAIL_COOKIE)?.value;
  if (value === undefined) return undefined;
  const parsed = emailSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
