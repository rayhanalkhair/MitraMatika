import type { Messages } from "next-intl";
import type { Locale } from "./config";

// Every catalog is imported statically, so a missing file fails the build and tests, not a request.
const catalogs = {
  id: () => import("../../../messages/id.json"),
  en: () => import("../../../messages/en.json"),
} as const satisfies Record<Locale, () => Promise<{ default: unknown }>>;

export async function loadMessages(locale: Locale): Promise<Messages> {
  return (await catalogs[locale]()).default;
}
