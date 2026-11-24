"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";

import { DASHBOARD_NAV } from "@/components/dashboard/nav-items";
import { cn } from "@/lib/utils";

type SidebarNavProps = {
  /** Called after a link is chosen — lets the mobile sheet close itself. */
  onNavigate?: () => void;
};

/**
 * usePathname() is unknown while prerendering pages with dynamic params (e.g.
 * /dashboard/presentations/[id]), so the active-link version streams in behind Suspense and the
 * prerendered fallback is the same list without an active item.
 */
export function SidebarNav(props: SidebarNavProps) {
  return (
    <Suspense fallback={<NavList pathname={null} {...props} />}>
      <ActiveNavList {...props} />
    </Suspense>
  );
}

function ActiveNavList(props: SidebarNavProps) {
  return <NavList pathname={usePathname()} {...props} />;
}

function NavList({ onNavigate, pathname }: SidebarNavProps & { pathname: string | null }) {
  return (
    <nav aria-label="Dashboard">
      <ul className="flex flex-col gap-1">
        {DASHBOARD_NAV.map((item) => {
          const Icon = item.icon;

          if (item.comingSoon) {
            return (
              <li key={item.href}>
                {/* Not a link: unavailable items are plain, non-focusable text with a spoken status. */}
                <span className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground">
                  <Icon className="size-4.5" aria-hidden="true" />
                  {item.label}
                  <span className="sr-only"> (coming soon, not available yet)</span>
                  <span
                    aria-hidden="true"
                    className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[0.7rem] font-semibold text-muted-foreground"
                  >
                    Soon
                  </span>
                </span>
              </li>
            );
          }

          const isActive = pathname !== null && (item.exact ? pathname === item.href : pathname.startsWith(item.href));

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onNavigate}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground hover:bg-muted",
                )}
              >
                <Icon className="size-4.5" aria-hidden="true" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
