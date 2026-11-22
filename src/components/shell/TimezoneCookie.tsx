"use client";

import { useEffect } from "react";
import { TZ_COOKIE, TZ_COOKIE_MAX_AGE } from "@/lib/timezone-shared";

function readCookie(): string | undefined {
  const prefix = `${TZ_COOKIE}=`;
  const entry = document.cookie.split("; ").find((part) => part.startsWith(prefix));
  if (entry === undefined) return undefined;
  try {
    return decodeURIComponent(entry.slice(prefix.length));
  } catch {
    return undefined;
  }
}

// Remembers the browser's time zone in a cookie so Server Components can format dates in it.
export function TimezoneCookie() {
  useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!zone || readCookie() === zone) return;
    const secure = window.location.protocol === "https:" ? "; secure" : "";
    document.cookie = `${TZ_COOKIE}=${encodeURIComponent(zone)}; path=/; max-age=${String(TZ_COOKIE_MAX_AGE)}; samesite=lax${secure}`;
  }, []);
  return null;
}
