import { useTranslations } from "next-intl";
import { mobileNavItems } from "./nav-config";
import { NavItem } from "./NavItem";

export function BottomNav() {
  const t = useTranslations("shell");
  return (
    <nav
      aria-label={t("bottomNavLabel")}
      className="fixed inset-x-0 bottom-0 z-10 flex min-h-[calc(var(--bottom-nav-h)+env(safe-area-inset-bottom))] items-center justify-around border-t border-border bg-card px-1 pt-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom))] shadow-sm md:hidden"
    >
      {mobileNavItems.map((item) => (
        <NavItem key={item.href} item={item} orientation="horizontal" />
      ))}
    </nav>
  );
}
