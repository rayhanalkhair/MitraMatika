"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { BottomNav } from "./BottomNav";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

export function AppShell({
  children,
  user,
}: {
  children: ReactNode;
  user: { name: string | null; email: string };
}) {
  const t = useTranslations("shell");
  return (
    <div className="flex min-h-dvh">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-lg focus:bg-card focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-sm focus:ring-2 focus:ring-ring"
      >
        {t("skipToContent")}
      </a>
      <Sidebar user={user} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar user={user} />
        <main
          id="main-content"
          tabIndex={-1}
          className="min-w-0 flex-1 pb-[calc(var(--bottom-nav-h)+0.5rem+env(safe-area-inset-bottom))] outline-none md:pb-0"
        >
          {children}
        </main>
      </div>
      <BottomNav />
    </div>
  );
}
