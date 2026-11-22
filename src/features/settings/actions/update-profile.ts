"use server";

import { revalidatePath } from "next/cache";
import {
  authorizeAction,
  formText,
  parseProfileForm,
  saveAccountProfile,
  type ProfileFormState,
} from "@/features/auth";

// Settings > Akun: the name and school of the signed-in user. The user id comes from the session
// only; nothing in the form can name another account.
export async function updateProfileAction(
  _previous: ProfileFormState,
  data: FormData,
): Promise<ProfileFormState> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { error: "unauthenticated" };

  const values = {
    name: formText(data, "name"),
    schoolName: formText(data, "schoolName"),
  };
  const parsed = parseProfileForm(data);
  if (!parsed.ok) return { fieldErrors: parsed.error, values };

  const saved = await saveAccountProfile({
    userId: authorization.data.userId,
    ...parsed.data,
  });
  if (!saved.ok) return { error: "generic", values };
  // The shell shows the name on every page.
  revalidatePath("/", "layout");
  return {
    savedAt: Date.now(),
    values: { name: parsed.data.name, schoolName: parsed.data.schoolName ?? "" },
  };
}
