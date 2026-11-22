// The UI locales. Indonesian is the default (the user is an Indonesian teacher); English is
// opt-in through the NEXT_LOCALE cookie. There is no URL prefix: the app has no public SEO pages.
export const locales = ["id", "en"] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "id";

export const LOCALE_COOKIE = "NEXT_LOCALE";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}

// Each language is named in its own language, whatever the current UI locale is.
export const LANGUAGE_NAMES: Record<Locale, string> = {
  id: "Bahasa Indonesia",
  en: "English",
};
