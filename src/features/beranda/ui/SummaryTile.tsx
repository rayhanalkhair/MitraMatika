import type { ReactNode } from "react";

// One figure of the Home summary row. Renders an <li>: the page places three of them in a list.
export function SummaryTile({
  label,
  value,
  icon,
  children,
}: {
  label: string;
  value: number;
  icon: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-5 shadow-card">
      <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-muted-foreground">
        <span aria-hidden="true" className="shrink-0 text-primary">
          {icon}
        </span>
        <span className="break-words">{label}</span>
      </span>
      <span className="font-heading text-3xl font-bold text-foreground">
        {value.toLocaleString("en-US", { useGrouping: false })}
      </span>
      {children}
    </li>
  );
}
