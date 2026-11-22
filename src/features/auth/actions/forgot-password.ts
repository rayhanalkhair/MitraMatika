"use server";

import { formText, parseEmailForm, type EmailFormState } from "../schema/auth-forms";
import { getAuthPort } from "../service/port-server";

// Public by design (the forgot-password form). Sends the address only: Better Auth always builds
// the link to the app's reset page, and refuses any absolute redirect. Every address gets the same
// confirmation; the address is not echoed back.
export async function requestPasswordResetAction(
  _previous: EmailFormState,
  data: FormData,
): Promise<EmailFormState> {
  const values = { email: formText(data, "email") };
  const parsed = parseEmailForm(data);
  if (!parsed.ok) return { fieldErrors: parsed.error, values };

  try {
    const port = await getAuthPort();
    const { error } = await port.requestPasswordReset({ email: parsed.data.email });
    if (error) {
      return { error: error.code === "rate_limited" ? "rateLimited" : "generic", values };
    }
  } catch {
    return { error: "generic", values };
  }
  return { sentAt: Date.now() };
}
