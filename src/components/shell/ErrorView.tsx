"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { StatusScreen } from "./StatusScreen";

const primaryButton =
  "inline-flex min-h-12 items-center justify-center rounded-lg bg-primary px-6 font-heading text-base font-semibold text-primary-foreground transition-colors duration-150 hover:bg-primary-hover";
const secondaryLink =
  "inline-flex min-h-12 items-center justify-center rounded-lg border border-border bg-card px-6 font-heading text-base font-semibold transition-colors duration-150 hover:bg-muted";

/**
 * The body of an error boundary: a sentence, "Coba lagi" (Next's `retry` re-fetches and
 * re-renders the segment) and a way home. It never shows the error, its message or its digest.
 */
export function ErrorView({ retry, framed }: { retry: () => void; framed: boolean }) {
  const t = useTranslations("systemPages.error");
  return (
    <StatusScreen title={t("title")} description={t("description")} framed={framed}>
      <button
        type="button"
        onClick={() => {
          retry();
        }}
        className={primaryButton}
      >
        {t("retry")}
      </button>
      <Link href="/home" className={secondaryLink}>
        {t("home")}
      </Link>
    </StatusScreen>
  );
}
