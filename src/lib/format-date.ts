import { createFormatter } from "next-intl";
import type { Locale } from "@/lib/i18n/config";

/** The locale and time zone a date is shown in: `useLocale()` / `useTimeZone()` on the page. */
export interface ViewerFormat {
  locale: Locale;
  timeZone: string;
}

// "8 November 2026": the date in the viewer's timezone and language. The locales `id` and `id-ID`
// give the same output, so the short code used by the app is enough.
export function formatBankDate(iso: string, { locale, timeZone }: ViewerFormat): string {
  const date = new Date(iso);
  // An unreadable value is shown as it is, never thrown at a page.
  if (Number.isNaN(date.getTime())) return iso;
  return createFormatter({ locale, timeZone }).dateTime(date, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
