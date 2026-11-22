import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// The content frame every page sits in: centred, 1280 px wide on desktop (768 px for forms),
// 16 px gutters on mobile and 32 px from `sm`. It adds no landmark; AppShell owns <main>.
export function PageContainer({
  children,
  width = "default",
  className,
}: {
  children: ReactNode;
  width?: "default" | "narrow";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mx-auto w-full min-w-0 px-4 py-6 sm:px-8",
        width === "narrow" ? "max-w-3xl" : "max-w-7xl",
        className,
      )}
    >
      {children}
    </div>
  );
}
