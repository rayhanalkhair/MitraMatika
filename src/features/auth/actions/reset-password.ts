"use server";

import { redirect } from "next/navigation";
import {
  formText,
  parseResetPasswordForm,
  type ResetPasswordState,
} from "../schema/auth-forms";
import { getAuthPort } from "../service/port-server";

// Public by design (the page the reset link opens). The token is the only credential; Better Auth
// checks it, uses it up and ends every session of the account.
export async function resetPasswordAction(
  _previous: ResetPasswordState,
  data: FormData,
): Promise<ResetPasswordState> {
  const token = formText(data, "token");
  if (token === "") return { expired: true };
  const parsed = parseResetPasswordForm(data);
  if (!parsed.ok) return { fieldErrors: parsed.error };

  try {
    const port = await getAuthPort();
    const { error } = await port.resetPassword({
      token,
      newPassword: parsed.data.password,
    });
    if (error?.code === "invalid_token") return { expired: true };
    if (error)
      return { error: error.code === "rate_limited" ? "rateLimited" : "generic" };
  } catch {
    return { error: "generic" };
  }
  redirect("/sign-in?notice=passwordReset");
}
