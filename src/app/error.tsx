"use client";

import { ErrorView } from "@/components/shell/ErrorView";

// Next 16 hands the boundary `retry` (re-fetch and re-render the segment). The error itself is
// never shown: its message can name a table, a file or an address.
export default function RootError({
  retry,
}: {
  error: unknown;
  retry: () => void;
  reset?: () => void;
}) {
  return <ErrorView retry={retry} framed={false} />;
}
