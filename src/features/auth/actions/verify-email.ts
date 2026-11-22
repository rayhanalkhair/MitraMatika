"use server";

import { formText, parseEmailForm, type EmailFormState } from "../schema/auth-forms";
import { EMAIL_SIGN_IN_CALLBACK } from "../service/core";
import { rememberPendingEmail } from "../service/pending-email";
import { getAuthPort } from "../service/port-server";

// Public by design (the resend on /verify-email). Better Auth answers every address the same way
// (only an unverified one gets a link, within the per-address limit), and so does this action.
export async function resendVerificationAction(
  _previous: EmailFormState,
  data: FormData,
): Promise<EmailFormState> {
  const values = { email: formText(data, "email") };
  const parsed = parseEmailForm(data);
  if (!parsed.ok) return { fieldErrors: parsed.error, values };

  try {
    const port = await getAuthPort();
    const { error } = await port.sendVerificationEmail({
      email: parsed.data.email,
      callbackURL: EMAIL_SIGN_IN_CALLBACK,
    });
    if (error) {
      return { error: error.code === "rate_limited" ? "rateLimited" : "generic", values };
    }
    await rememberPendingEmail(parsed.data.email);
  } catch {
    return { error: "generic", values };
  }
  return { sentAt: Date.now(), values };
}
