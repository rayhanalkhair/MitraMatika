import { useId, type ReactNode } from "react";

// One numbered step of the create-questions form: a number badge, a heading and the controls.
export function StepCard({
  step,
  title,
  children,
}: {
  step: number;
  title: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 shadow-card sm:p-6"
    >
      <div className="flex items-center gap-3">
        <span
          data-step=""
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary font-heading text-sm font-bold text-primary-foreground"
        >
          {step}
        </span>
        <h2 id={headingId} className="font-heading text-lg font-bold text-foreground">
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}
