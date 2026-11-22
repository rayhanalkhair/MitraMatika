"use server";

import { redirect } from "next/navigation";
import { auditSignOut } from "../service/audit";
import { signOutUser } from "../service/core";
import { clearFakeSession } from "../service/e2e-session-server";
import { forgetPendingEmail } from "../service/pending-email";
import { authorizeAction } from "../service/guard";
import { getAuthPort } from "../service/port-server";

export async function signOutAction(): Promise<void> {
  const authorization = await authorizeAction();
  await signOutUser(getAuthPort);
  await clearFakeSession();
  await forgetPendingEmail();
  if (authorization.ok) await auditSignOut(authorization.data);
  redirect("/sign-in");
}
