import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { requireSignedInUser } from "@/features/auth";

// The pages of a signed-in account that is not approved yet (ADR-0022): no app shell. Only the
// signed-in guard runs here; an approved account has no business on these pages.
export default async function PendingLayout({ children }: { children: ReactNode }) {
  const user = await requireSignedInUser();
  if (user.status === "allowed") redirect("/home");
  return <>{children}</>;
}
