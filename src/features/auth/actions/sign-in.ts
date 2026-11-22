"use server";

import { redirect } from "next/navigation";
import {
  formText,
  parseSignInForm,
  type FormErrorKey,
  type SignInState,
} from "../schema/auth-forms";
import { auditSignIn } from "../service/audit";
import type { AuthPortError } from "../service/auth-port";
import { EMAIL_SIGN_IN_CALLBACK } from "../service/core";
import { forgetPendingEmail, rememberPendingEmail } from "../service/pending-email";
import { getAuthPort } from "../service/port-server";
import { completeSignIn } from "../service/sign-in";

const SIGN_IN_ERRORS: Partial<Record<AuthPortError["code"], FormErrorKey>> = {
  invalid_credentials: "invalidCredentials",
  rate_limited: "rateLimited",
  email_not_verified: "emailNotVerified",
};

// Public by design (the sign-in form). Goes through auth.handler via the port, so Better Auth's
// per-IP limit applies.
export async function signInAction(
  _previous: SignInState,
  data: FormData,
): Promise<SignInState> {
  const values = { email: formText(data, "email") };
  const parsed = parseSignInForm(data);
  if (!parsed.ok) return { fieldErrors: parsed.error, values };

  try {
    const port = await getAuthPort();
    const { error } = await port.signInEmail({
      ...parsed.data,
      callbackURL: EMAIL_SIGN_IN_CALLBACK,
    });
    if (error) {
      // Only after the right password: Better Auth has just resent the link.
      if (error.code === "email_not_verified")
        await rememberPendingEmail(parsed.data.email);
      return { error: SIGN_IN_ERRORS[error.code] ?? "generic", values };
    }
    const completed = await completeSignIn(port, auditSignIn("email"));
    if (!completed.ok) return { error: "generic", values };
    await forgetPendingEmail();
  } catch {
    return { error: "generic", values };
  }
  redirect("/home");
}
