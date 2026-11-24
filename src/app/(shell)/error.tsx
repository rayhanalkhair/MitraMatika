"use client";

import { ErrorView } from "@/components/shell/ErrorView";

// A failure inside the signed-in area keeps the app frame (the shell layout is above this boundary).
export default function ShellError({
  retry,
}: {
  error: unknown;
  retry: () => void;
  reset?: () => void;
}) {
  return <ErrorView retry={retry} framed />;
}
