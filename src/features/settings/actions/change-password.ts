"use server";

import {
  authorizeAction,
  changeAccountPassword,
  parseChangePasswordForm,
  type ChangePasswordState,
} from "@/features/auth";

// Settings > Akun: the signed-in user's password (credential accounts only; Better Auth answers
// any other account with an error). The user comes from the session only. No password is ever
// returned in the state.
export async function changePasswordAction(
  _previous: ChangePasswordState,
  data: FormData,
): Promise<ChangePasswordState> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { error: "unauthenticated" };

  const parsed = parseChangePasswordForm(data);
  if (!parsed.ok) return { fieldErrors: parsed.error };

  const changed = await changeAccountPassword({
    userId: authorization.data.userId,
    ...parsed.data,
  });
  if (changed.ok) return { savedAt: Date.now() };
  if (changed.error === "wrongPassword") {
    return { fieldErrors: { currentPassword: "wrongPassword" } };
  }
  return { error: changed.error === "rateLimited" ? "rateLimited" : "generic" };
}
