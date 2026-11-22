import type { MessageCatalog } from "@/lib/i18n/keys";
import type { Result } from "@/lib/result";

export type AuthErrorKey = keyof MessageCatalog["auth"]["errors"];
export type AuthNoticeKey = keyof MessageCatalog["auth"]["notices"];

export type AuthResult = Result<void, AuthErrorKey>;
