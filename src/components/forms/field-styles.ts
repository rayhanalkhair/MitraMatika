// Shared by the form fields and the forms that use them.
export const inputClass =
  "min-h-12 w-full min-w-0 rounded-lg border border-input bg-card px-3 text-base transition-colors duration-150 placeholder:text-muted-foreground aria-invalid:border-destructive";

export const submitClass =
  "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary px-6 font-heading text-base font-semibold text-primary-foreground transition-colors duration-150 hover:bg-primary-hover disabled:opacity-60";

export const linkClass =
  "inline-flex min-h-11 items-center font-semibold text-primary underline-offset-4 hover:underline";

/** aria-describedby from the ids that exist (error first), or undefined. */
export function describedBy(...ids: (string | undefined)[]): string | undefined {
  const present = ids.filter((id): id is string => Boolean(id));
  return present.length > 0 ? present.join(" ") : undefined;
}
