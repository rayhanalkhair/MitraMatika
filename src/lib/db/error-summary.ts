// A database error message carries the SQL parameters (question text, hints, notes). Log only the
// error name and the Postgres code, found on the error or on the driver error Drizzle wraps.
export function safeErrorSummary(error: unknown): { name: string; code: string | null } {
  const outer = error as
    { code?: unknown; cause?: { code?: unknown } } | null | undefined;
  const code = outer?.code ?? outer?.cause?.code;
  return {
    name: error instanceof Error ? error.name : typeof error,
    code: typeof code === "string" ? code : null,
  };
}
