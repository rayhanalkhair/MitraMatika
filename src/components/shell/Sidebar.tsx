import { useTranslations } from "next-intl";
import { allNavItems } from "./nav-config";
import { NavItem } from "./NavItem";
import { UserCard } from "./UserCard";

export function Sidebar({ user }: { user: { name: string | null; email: string } }) {
  const t = useTranslations("shell");
  // A group with nothing in it (no section is "coming soon" today) is not shown.
  const groups = [
    { id: "main", label: t("groupMain") },
    { id: "soon", label: t("groupSoon") },
  ].filter((group) =>
    allNavItems.some((item) => item.href !== "/more" && item.group === group.id),
  );
  return (
    <nav
      aria-label={t("sidebarNavLabel")}
      className="sticky top-0 hidden h-dvh w-72 shrink-0 flex-col gap-1 overflow-y-auto border-r border-sidebar-border bg-sidebar p-3 md:flex"
    >
      <div className="mb-4 flex items-center gap-3 px-2.5 py-2">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary font-heading text-lg font-bold text-primary-foreground"
        >
          M
        </span>
        <span className="font-heading text-lg font-bold tracking-tight">MitraMatika</span>
      </div>
      {groups.map((group) => (
        <div key={group.id} className="mb-3 flex flex-col gap-1">
          <p
            id={`sidebar-group-${group.id}`}
            className="px-2.5 pb-1 font-heading text-xs font-semibold tracking-wider text-muted-foreground uppercase"
          >
            {group.label}
          </p>
          <ul
            aria-labelledby={`sidebar-group-${group.id}`}
            className="flex flex-col gap-1"
          >
            {allNavItems
              .filter((item) => item.href !== "/more" && item.group === group.id)
              .map((item) => (
                <li key={item.href}>
                  <NavItem item={item} orientation="vertical" />
                </li>
              ))}
          </ul>
        </div>
      ))}
      <div className="mt-auto">
        <UserCard name={user.name} email={user.email} />
      </div>
    </nav>
  );
}
