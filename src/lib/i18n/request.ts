import { getRequestConfig } from "next-intl/server";
import { readLocaleCookie } from "./locale-cookie";
import { getViewerTimezone } from "@/lib/timezone";
import { loadMessages } from "./messages";

// next-intl "without i18n routing": the locale comes from the NEXT_LOCALE cookie, never the URL.
export default getRequestConfig(async () => {
  const locale = await readLocaleCookie();
  // The viewer's zone (tz cookie, Asia/Jakarta by default) is what every useFormatter()
  // and getFormatter() call formats dates in, on the server and in Client Components.
  const timeZone = await getViewerTimezone();
  return { locale, messages: await loadMessages(locale), timeZone };
});
