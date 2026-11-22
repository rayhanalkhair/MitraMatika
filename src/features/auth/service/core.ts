import { err, ok } from "@/lib/result";
import type { AuthErrorKey, AuthResult } from "../schema/types";
import type { AuthPortGetter } from "./auth-port";
import { completeSignIn, type SignedInCallback } from "./sign-in";

const FAIL = (messageKey: AuthErrorKey): AuthResult => err(messageKey);

export async function signOutUser(getPort: AuthPortGetter): Promise<AuthResult> {
  try {
    const port = await getPort();
    const { error } = await port.signOut();
    return error ? FAIL("generic") : ok();
  } catch {
    return FAIL("generic");
  }
}

/**
 * Where every verification link leads after Better Auth has checked it (a relative path, so
 * Better Auth's origin check trusts it): with a session on success, with `&error=` otherwise.
 */
export const EMAIL_SIGN_IN_CALLBACK = "/auth/callback?method=email";

/**
 * Where `/auth/callback` sends the browser after Better Auth finished Google's callback or a
 * verification link. Better Auth reports its own failures (including a refused account) as
 * `?error=`; a failed verification link (expired, tampered, used up) goes to the page that
 * sends a new one.
 */
export async function resolvePostSignInRedirect(
  getPort: AuthPortGetter,
  searchParams: URLSearchParams,
  onSignedIn?: SignedInCallback,
): Promise<string> {
  if (searchParams.get("error")) {
    return searchParams.get("method") === "email"
      ? "/verify-email?error=invalid"
      : "/sign-in?error=oauthDenied";
  }

  try {
    const port = await getPort();
    // A verification link that was already used: Better Auth redirects here without an error and
    // without a session (the address is confirmed already). Only the holder of the link gets here,
    // so saying the link is used up tells nothing about any other address.
    if (searchParams.get("method") === "email" && !(await port.getSessionUser())) {
      return "/sign-in?notice=linkUsed";
    }
    const result = await completeSignIn(port, onSignedIn);
    return result.ok ? "/home" : `/sign-in?error=${result.error}`;
  } catch {
    return "/sign-in?error=generic";
  }
}
