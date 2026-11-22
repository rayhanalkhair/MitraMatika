// Class strings shared by the materials screens: 44 px targets, the redesign tokens.
export const primaryButton =
  "inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors duration-150 hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60";

export const secondaryButton =
  "inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg border bg-card px-4 text-sm font-semibold text-foreground transition-colors duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60";

export const iconButton =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-lg border bg-card text-foreground transition-colors duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40";

export const control =
  "min-h-11 w-full min-w-0 rounded-lg border border-input bg-card px-3 text-sm text-foreground aria-invalid:border-destructive";

export const card =
  "flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4 shadow-card";

export const noticeClass = (kind: "status" | "alert") =>
  kind === "alert"
    ? "rounded-lg border border-destructive/30 bg-destructive-soft p-3 text-sm font-medium text-destructive-foreground"
    : "rounded-lg border border-border bg-muted p-3 text-sm";
