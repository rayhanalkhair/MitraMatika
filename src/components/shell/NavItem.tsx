"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { isNavItemActive, type NavConfigItem } from "./nav-config";

export function NavItem({
  item,
  orientation,
}: {
  item: NavConfigItem;
  orientation: "vertical" | "horizontal";
}) {
  const t = useTranslations("common");
  const tNav = useTranslations("nav");
  const pathname = usePathname();
  const active = isNavItemActive(pathname, item.href);
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex min-h-11 items-center px-3 py-2 text-sm font-medium transition-colors duration-150",
        orientation === "vertical"
          ? "w-full gap-2.5 rounded-lg px-2.5"
          : "min-w-11 flex-col gap-1 rounded-xl px-2 py-1.5 text-xs",
        active
          ? "bg-accent font-semibold text-accent-foreground"
          : "text-muted-foreground hover:bg-secondary hover:text-foreground",
      )}
    >
      <Icon
        className={cn("size-5 shrink-0", active && "text-primary")}
        aria-hidden="true"
      />
      <span className="min-w-0 whitespace-nowrap">{tNav(item.labelKey)}</span>
      {item.comingSoon && orientation === "horizontal" && (
        <span className="absolute top-1 right-2 size-2.5 rounded-full bg-warning ring-2 ring-card">
          <span className="sr-only">{t("soonBadge")}</span>
        </span>
      )}
      {item.comingSoon && orientation === "vertical" && (
        <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none font-medium whitespace-nowrap text-muted-foreground ring-1 ring-border">
          {t("soonBadge")}
        </span>
      )}
    </Link>
  );
}
