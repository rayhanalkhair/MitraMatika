import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { requireAllowedUser } from "@/features/auth";

export default async function ShellLayout({ children }: { children: ReactNode }) {
  const user = await requireAllowedUser();
  return (
    <AppShell user={{ name: user.displayName, email: user.email }}>{children}</AppShell>
  );
}
