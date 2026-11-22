import type { Metadata } from "next";
import { Manrope, Plus_Jakarta_Sans } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { TimezoneCookie } from "@/components/shell/TimezoneCookie";
import "./globals.css";
import { Providers } from "./providers";

// Body and numbers (--font-sans).
const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
  display: "swap",
});

// Friendly geometric face for headings, the brand name and big numbers (--font-heading).
const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "MitraMatika", template: "%s – MitraMatika" },
  description: "Asisten Cerdas untuk Guru Matematika",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // The locale comes from the NEXT_LOCALE cookie (src/lib/i18n/request.ts); Indonesian by default.
  const locale = await getLocale();
  const messages = await getMessages();
  return (
    <html
      lang={locale}
      className={`${manrope.variable} ${jakarta.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <TimezoneCookie />
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
