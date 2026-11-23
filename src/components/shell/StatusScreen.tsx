import type { ReactNode } from "react";
import { PageContainer } from "./PageContainer";

/**
 * A page-sized message: the 404 and the runtime error. One h1, a sentence and the way out.
 * `framed` is for the signed-in area, where AppShell already owns <main>; unframed it is its own
 * page with the brand and a <main> (the root 404 and error screens, which render without the shell).
 */
export function StatusScreen({
  title,
  description,
  children,
  framed,
}: {
  title: string;
  description: string;
  children: ReactNode;
  framed: boolean;
}) {
  const card = (
    <div className="flex w-full max-w-md flex-col gap-4 rounded-xl border bg-card p-6 shadow-card sm:p-8">
      <h1 className="font-heading text-2xl font-bold">{title}</h1>
      <p className="text-muted-foreground">{description}</p>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
  if (framed) {
    return (
      <PageContainer width="narrow" className="py-12 sm:py-20">
        {card}
      </PageContainer>
    );
  }
  return (
    <main className="flex min-h-dvh w-full flex-col items-center justify-center gap-6 bg-background px-4 py-8">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary font-heading text-lg font-bold text-primary-foreground"
        >
          M
        </span>
        <span className="font-heading text-xl font-bold tracking-tight">MitraMatika</span>
      </div>
      {card}
    </main>
  );
}
