"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useTransition } from "react";
import { LANGUAGE_NAMES, locales, type Locale } from "@/lib/i18n/config";
import { setLocaleAction } from "../actions/set-locale";

const choiceClass =
  "flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-lg px-4 text-sm font-medium text-secondary-foreground transition-colors duration-150 peer-checked:bg-primary peer-checked:font-semibold peer-checked:text-primary-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:cursor-wait peer-disabled:opacity-60";

export function LanguageSwitch() {
  const t = useTranslations("settings.language");
  const current = useLocale();
  const [pending, startTransition] = useTransition();
  const descriptionId = useId();

  function choose(locale: Locale) {
    if (locale === current) return;
    startTransition(async () => {
      await setLocaleAction(locale);
    });
  }

  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-5 shadow-card">
      <h2 className="font-heading text-lg font-bold">{t("heading")}</h2>
      <p id={descriptionId} className="text-sm text-muted-foreground">
        {t("description")}
      </p>
      <fieldset aria-describedby={descriptionId} className="flex flex-col gap-2">
        <legend className="sr-only">{t("groupLabel")}</legend>
        <div className="inline-flex flex-wrap gap-1 self-start rounded-lg bg-muted p-1">
          {locales.map((locale) => (
            <div key={locale}>
              <input
                type="radio"
                name="locale"
                id={`locale-${locale}`}
                value={locale}
                lang={locale}
                checked={current === locale}
                disabled={pending}
                onChange={() => {
                  choose(locale);
                }}
                className="peer sr-only"
              />
              <label htmlFor={`locale-${locale}`} lang={locale} className={choiceClass}>
                {LANGUAGE_NAMES[locale]}
              </label>
            </div>
          ))}
        </div>
      </fieldset>
    </section>
  );
}
