"use client";

import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";
import { setLocaleAction } from "@/features/settings/actions/set-locale";
import { LANGUAGE_NAMES, locales, type Locale } from "@/lib/i18n/config";

export function LanguageLinks() {
  const t = useTranslations("settings.language");
  const current = useLocale();
  const [pending, startTransition] = useTransition();

  function choose(locale: Locale) {
    if (locale === current) return;
    startTransition(async () => {
      await setLocaleAction(locale);
    });
  }

  return (
    <div role="group" aria-label={t("groupLabel")} className="flex items-center gap-1">
      {locales.map((locale) => (
        <button
          key={locale}
          type="button"
          lang={locale}
          aria-pressed={current === locale}
          disabled={pending}
          onClick={() => {
            choose(locale);
          }}
          className="min-h-11 rounded-lg px-3 text-sm text-muted-foreground transition-colors duration-150 hover:text-primary disabled:cursor-wait disabled:opacity-60 aria-pressed:font-semibold aria-pressed:text-primary"
        >
          {LANGUAGE_NAMES[locale]}
        </button>
      ))}
    </div>
  );
}
