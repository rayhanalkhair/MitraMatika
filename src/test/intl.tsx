import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement, ReactNode } from "react";
import type { Locale } from "@/lib/i18n/config";
import enMessages from "../../messages/en.json";
import idMessages from "../../messages/id.json";

const catalogs = { id: idMessages, en: enMessages };

export function IntlWrapper({
  children,
  locale = "id",
  timeZone = "Asia/Jakarta",
}: {
  children: ReactNode;
  locale?: Locale;
  timeZone?: string;
}) {
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={catalogs[locale]}
      timeZone={timeZone}
    >
      {children}
    </NextIntlClientProvider>
  );
}

/** A `wrapper` for `renderHook` / `render` that provides the real catalog of `locale`. */
export function intlWrapper(locale: Locale = "id", timeZone?: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <IntlWrapper locale={locale} timeZone={timeZone}>
        {children}
      </IntlWrapper>
    );
  };
}

/** `render` inside a NextIntlClientProvider with the real messages (Indonesian by default). */
export function renderWithIntl(
  ui: ReactElement,
  {
    locale = "id",
    timeZone,
    ...options
  }: { locale?: Locale; timeZone?: string } & Omit<RenderOptions, "wrapper"> = {},
): RenderResult {
  return render(ui, { ...options, wrapper: intlWrapper(locale, timeZone) });
}
