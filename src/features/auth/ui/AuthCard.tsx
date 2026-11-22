import type { ReactNode } from "react";
import { LanguageLinks } from "./LanguageLinks";

/**
 * The frame of every auth screen: the brand, one card (12 px radius) with the page's only h1, and
 * the language switch. The card keeps a minimum height, so switching between a form and its
 * confirmation does not make the page jump.
 */
export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh w-full flex-col items-center justify-center gap-6 bg-background bg-[radial-gradient(var(--border)_1px,transparent_1px)] bg-size-[24px_24px] px-4 py-8">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary font-heading text-lg font-bold text-primary-foreground"
        >
          M
        </span>
        <span className="font-heading text-xl font-bold tracking-tight">MitraMatika</span>
      </div>
      <div
        data-testid="auth-card"
        className="flex min-h-[28rem] w-full max-w-md flex-col gap-6 rounded-xl border bg-card p-6 shadow-card sm:p-8"
      >
        <div>
          <h1 className="font-heading text-2xl font-bold">{title}</h1>
          {description && (
            <p data-slot="auth-description" className="mt-2 text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        <div className="flex flex-1 flex-col gap-6">{children}</div>
        {footer && (
          <div
            data-slot="auth-footer"
            className="border-t pt-4 text-center text-sm text-muted-foreground"
          >
            {footer}
          </div>
        )}
      </div>
      <LanguageLinks />
    </main>
  );
}
