import type { locales } from "@/lib/i18n/config";
import type messages from "../../messages/id.json";

// Typed keys and ICU arguments: `t("buatSoal.resultCount", { count })` is checked against id.json.
declare module "next-intl" {
  interface AppConfig {
    Locale: (typeof locales)[number];
    Messages: typeof messages;
  }
}
