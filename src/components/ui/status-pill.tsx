import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const TONES = {
  success: "border-success/30 bg-success-soft text-success-foreground",
  warning: "border-warning/40 bg-warning-soft text-warning-foreground",
  destructive: "border-destructive/30 bg-destructive-soft text-destructive-foreground",
  ai: "border-ai/30 bg-ai-soft text-ai-foreground",
  neutral: "border-border bg-muted text-secondary-foreground",
} as const;

export type StatusTone = keyof typeof TONES;

// Callers render any icon as a child, so no component reference crosses a server/client boundary.
export function StatusPill({
  tone,
  className,
  children,
  ...rest
}: { tone: StatusTone; className?: string; children: ReactNode } & Omit<
  React.ComponentProps<"span">,
  "children" | "className"
>) {
  return (
    <span
      {...rest}
      data-tone={tone}
      className={cn(
        "inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-sm font-medium",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
