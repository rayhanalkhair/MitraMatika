"use server";

import { redirect } from "next/navigation";
import {
  authorizeSignedIn,
  clearFakeSession,
  deleteAccount,
  formText,
  getAuthPort,
  signOutUser,
  type DeleteAccountState,
} from "@/features/auth";
import { emailConfirmationMatches } from "../schema/delete-confirmation";

async function leaveDeletedAccount(): Promise<never> {
  // The sessions went with the account; this clears the browser's cookies too. A failure here
  // changes nothing: the old cookie no longer opens any session.
  await signOutUser(getAuthPort);
  await clearFakeSession();
  redirect("/sign-in?notice=accountDeleted");
}

// Settings > Akun, also open to a pending account (ADR-0022). Deletes the signed-in user's
// account and everything it owns (decision 9). The account comes from the session only; the
// typed address must be the session's, and a fresh credential is needed (ruling S11): the
// current password, or for an account without one a session from the last 10 minutes.
export async function deleteAccountAction(
  _previous: DeleteAccountState,
  data: FormData,
): Promise<DeleteAccountState> {
  const authorization = await authorizeSignedIn();
  if (!authorization.ok) return { error: "unauthenticated" };
  const { userId, email, sessionCreatedAt } = authorization.data;

  if (!emailConfirmationMatches(formText(data, "confirmEmail"), email)) {
    return { fieldErrors: { confirmEmail: "emailMismatch" } };
  }

  const deleted = await deleteAccount({
    userId,
    email,
    sessionCreatedAt,
    currentPassword: formText(data, "currentPassword"),
  });
  if (deleted.ok) return leaveDeletedAccount();
  switch (deleted.error) {
    case "passwordRequired":
    case "wrongPassword":
      return { fieldErrors: { currentPassword: deleted.error } };
    case "rateLimited":
    case "signInAgain":
      return { error: deleted.error };
    // Already gone (a second tab, or a request that waited for the first): same ending.
    case "notFound":
      return leaveDeletedAccount();
    default:
      return { error: "generic" };
  }
}
