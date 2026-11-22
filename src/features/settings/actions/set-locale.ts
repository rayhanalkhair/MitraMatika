"use server";

import { revalidatePath } from "next/cache";
import { isLocale } from "@/lib/i18n/config";
import { writeLocaleCookie } from "@/lib/i18n/locale-cookie";

export type SetLocaleResult = { ok: true } | { ok: false };

// Writes the NEXT_LOCALE cookie, then refreshes the whole tree so every Server Component
// renders again in the new language. The argument comes from the client: validate it.
export async function setLocaleAction(locale: unknown): Promise<SetLocaleResult> {
  if (!isLocale(locale)) return { ok: false };
  await writeLocaleCookie(locale);
  revalidatePath("/", "layout");
  return { ok: true };
}
