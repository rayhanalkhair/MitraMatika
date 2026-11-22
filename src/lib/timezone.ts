import "server-only";
import { cookies } from "next/headers";
import { DEFAULT_TIMEZONE, TZ_COOKIE } from "./timezone-shared";

export { DEFAULT_TIMEZONE, TZ_COOKIE, TZ_COOKIE_MAX_AGE } from "./timezone-shared";

const MAX_ZONE_LENGTH = 64;

/** True for an IANA time zone the runtime knows. Anything else (paths, offsets, junk) is false. */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ZONE_LENGTH) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
  } catch {
    return false;
  }
  // The constructor also accepts offsets such as "+07:00"; IANA names never start with a sign.
  return /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(value);
}

/**
 * The viewer's time zone from the `tz` cookie (set by TimezoneCookie on the first visit).
 * Server only. A missing or invalid cookie, or a call outside a request, gives Asia/Jakarta.
 */
export async function getViewerTimezone(): Promise<string> {
  try {
    const store = await cookies();
    const value = store.get(TZ_COOKIE)?.value;
    return isValidTimeZone(value) ? value : DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}
