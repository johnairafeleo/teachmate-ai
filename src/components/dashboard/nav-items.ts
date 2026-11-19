import { CirclePlus, LayoutDashboard, Library, Settings, type LucideIcon } from "lucide-react";

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Exact match for active state (used by the dashboard root). */
  exact?: boolean;
  /** Not built yet — shown disabled with a "Soon" tag. */
  comingSoon?: boolean;
};

export const DASHBOARD_NAV: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, exact: true },
  { label: "Create presentation", href: "/dashboard/create", icon: CirclePlus },
  { label: "My presentations", href: "/dashboard/presentations", icon: Library, comingSoon: true },
  { label: "Settings", href: "/dashboard/settings", icon: Settings, comingSoon: true },
];
