// A database error message carries the SQL parameters. Log only the error name and Postgres code.
export function safeErrorSummary(error: unknown): { name: string; code: string | null } {
  // Drizzle wraps the driver error: its Postgres code sits on `cause`.
  const outer = error as
    { code?: unknown; cause?: { code?: unknown } } | null | undefined;
  const code = outer?.code ?? outer?.cause?.code;
  return {
    name: error instanceof Error ? error.name : typeof error,
    code: typeof code === "string" ? code : null,
  };
}
