import type { ReactNode } from "react";

// The page heading block: the page's only h1, an optional eyebrow above and description below,
// with actions and status on the right from `md` (stacked under the title below it).
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  status,
}: {
  title: string;
  description?: string;
  eyebrow?: string;
  actions?: ReactNode;
  status?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="font-heading text-xs font-semibold tracking-wide text-primary uppercase">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="font-heading text-2xl font-bold break-words text-foreground md:text-3xl">
          {title}
        </h1>
        {description ? <p className="mt-1 text-muted-foreground">{description}</p> : null}
      </div>
      {actions || status ? (
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          {status}
          {actions}
        </div>
      ) : null}
    </div>
  );
}
