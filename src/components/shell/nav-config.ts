import {
  BookOpen,
  Calculator,
  ClipboardList,
  FolderOpen,
  Home,
  MoreHorizontal,
  PlusCircle,
  Settings,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type { MessageCatalog } from "@/lib/i18n/keys";

export type NavLabelKey = keyof MessageCatalog["nav"];

export interface NavConfigItem {
  href: string;
  // A key into `nav` in the message catalogs; the nav components translate it.
  labelKey: NavLabelKey;
  icon: LucideIcon;
  // The sidebar group: live sections under "main", placeholders under "soon".
  group: "main" | "soon";
  mobileBottomNav: boolean;
  // The page exists but is still a placeholder: the nav item carries a "Segera" badge.
  comingSoon?: boolean;
}

export const allNavItems: NavConfigItem[] = [
  {
    href: "/home",
    labelKey: "beranda",
    icon: Home,
    group: "main",
    mobileBottomNav: true,
  },
  {
    href: "/generate",
    labelKey: "buatSoal",
    icon: PlusCircle,
    group: "main",
    mobileBottomNav: true,
  },
  {
    href: "/question-bank",
    labelKey: "bankSoal",
    icon: BookOpen,
    group: "main",
    mobileBottomNav: true,
  },
  {
    href: "/solve",
    labelKey: "selesaikan",
    icon: Calculator,
    group: "main",
    mobileBottomNav: true,
  },
  {
    href: "/materials",
    labelKey: "materi",
    icon: FolderOpen,
    group: "main",
    mobileBottomNav: false,
  },
  {
    href: "/assessment-builder",
    labelKey: "penyusunAsesmen",
    icon: ClipboardList,
    group: "main",
    mobileBottomNav: false,
  },
  {
    href: "/trash",
    labelKey: "sampah",
    icon: Trash2,
    group: "main",
    mobileBottomNav: false,
  },
  {
    href: "/settings",
    labelKey: "pengaturan",
    icon: Settings,
    group: "main",
    mobileBottomNav: false,
  },
  {
    href: "/more",
    labelKey: "lainnya",
    icon: MoreHorizontal,
    group: "main",
    mobileBottomNav: true,
  },
];

export const mobileNavItems: NavConfigItem[] = allNavItems.filter(
  (item) => item.mobileBottomNav,
);

export function isNavItemActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
