"use server";

import { redirect } from "next/navigation";
import { formText, parseSignUpForm, type SignUpState } from "../schema/auth-forms";
import { EMAIL_SIGN_IN_CALLBACK } from "../service/core";
import { rememberPendingEmail } from "../service/pending-email";
import { getAuthPort } from "../service/port-server";

// Public by design (the sign-up form). Better Auth answers a new and an existing address the same
// way (the existing one gets the account-exists email instead), and so does this action: both go
// to the same /verify-email notice.
export async function signUpAction(
  _previous: SignUpState,
  data: FormData,
): Promise<SignUpState> {
  const values = {
    name: formText(data, "name"),
    email: formText(data, "email"),
    schoolName: formText(data, "schoolName"),
    acceptPrivacy: formText(data, "acceptPrivacy"),
  };
  const parsed = parseSignUpForm(data);
  if (!parsed.ok) return { fieldErrors: parsed.error, values };

  try {
    const port = await getAuthPort();
    const { error } = await port.signUpEmail({
      ...parsed.data,
      callbackURL: EMAIL_SIGN_IN_CALLBACK,
    });
    if (error) {
      return { error: error.code === "rate_limited" ? "rateLimited" : "generic", values };
    }
    await rememberPendingEmail(parsed.data.email);
  } catch {
    return { error: "generic", values };
  }
  redirect("/verify-email");
}
