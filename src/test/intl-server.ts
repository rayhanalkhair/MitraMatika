import { defaultLocale, type Locale } from "@/lib/i18n/config";

// The locale the mocked `next-intl/server` serves. Tests that render a Server Component or call
// an action in English set it; it resets to Indonesian before every test file.
let current: Locale = defaultLocale;

export function setTestLocale(locale: Locale): void {
  current = locale;
}

export function getTestLocale(): Locale {
  return current;
}

// The viewer timezone the mocked `next-intl/server` serves; Asia/Jakarta unless a test changes it.
let currentZone = "Asia/Jakarta";

export function setTestTimeZone(zone: string): void {
  currentZone = zone;
}

export function getTestTimeZone(): string {
  return currentZone;
}
