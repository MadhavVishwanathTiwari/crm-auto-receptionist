"use client";

import { PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useState } from "react";

import { Kbd } from "@/components/ui/Kbd";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";
import { openCommandPalette } from "@/lib/ui/palette";
import { SIDEBAR_COOKIE } from "@/lib/ui/cookies";

import { AlertBadge } from "./AlertBadge";
import { CommandPalette } from "./CommandPalette";
import { NAV } from "./nav";
import { UserMenu } from "./UserMenu";

/**
 * The app's chrome.
 *
 * Fourteen links used to sit in one non-wrapping 36px row with no active state
 * at all -- every one of them carried an identical className, so the screen you
 * were on looked exactly like the thirteen you were not. The row was also at
 * its width limit, which is why the signed-in address had been cut down to its
 * local part.
 *
 * A client component so it can call usePathname(). The layout above it stays a
 * server component: it holds requireOrgContext(), which is cache()d and shared
 * with the page and the drawer below, and auth cannot move to the browser.
 */
export function AppSidebar({
  email,
  role,
  openAlerts,
  initialCollapsed,
}: {
  email: string | null;
  role: string;
  openAlerts: number;
  initialCollapsed: boolean;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(initialCollapsed);

  const toggle = useCallback(() => {
    setCollapsed((value) => {
      const next = !value;
      // Written for the next server render, not read back on this one. No
      // router.refresh(): a sidebar width has no server-rendered consequence
      // beyond the first paint, and every page here is force-dynamic against a
      // database in Tokyo.
      document.cookie = `${SIDEBAR_COOKIE}=${next ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
      return next;
    });
  }, []);

  return (
    <>
      <aside
        className={cn(
          "flex h-full shrink-0 flex-col border-r border-line bg-surface",
          "transition-[width] duration-(--duration-base) ease-(--ease-out)",
          collapsed ? "w-[52px]" : "w-[224px]",
        )}
      >
        {/* Brand */}
        <div
          className={cn(
            "flex h-11 shrink-0 items-center gap-2 border-b border-line px-3",
            collapsed && "justify-center px-0",
          )}
        >
          {!collapsed && (
            <span className="min-w-0 flex-1 truncate font-semibold text-ink">
              Outreach Ops
            </span>
          )}
          <Tooltip
            content={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            side="right"
          >
            <button
              type="button"
              onClick={toggle}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!collapsed}
              className="cursor-pointer rounded-md p-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink"
            >
              {collapsed ? (
                <PanelLeftOpen size={15} strokeWidth={1.75} />
              ) : (
                <PanelLeftClose size={15} strokeWidth={1.75} />
              )}
            </button>
          </Tooltip>
        </div>

        {/* Search, which is the command palette wearing an input's clothes. */}
        <div className={cn("shrink-0 p-2", collapsed && "px-1.5")}>
          <Tooltip content="Search" side="right" className="w-full">
            <button
              type="button"
              onClick={openCommandPalette}
              aria-label="Search"
              className={cn(
                "flex h-7 w-full cursor-pointer items-center gap-2 rounded-md border border-line",
                "bg-surface-2 px-2 text-ink-3 hover:border-line-2 hover:text-ink-2",
                collapsed && "justify-center px-0",
              )}
            >
              <Search size={14} strokeWidth={1.75} className="shrink-0" />
              {!collapsed && (
                <>
                  <span className="flex-1 text-left">Search</span>
                  <Kbd>Ctrl K</Kbd>
                </>
              )}
            </button>
          </Tooltip>
        </div>

        {/* Navigation */}
        <nav
          aria-label="Main"
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
        >
          {NAV.map((group) => (
            <div key={group.label} className="mb-3 last:mb-0">
              {collapsed ? (
                <div className="mx-auto my-2 h-px w-6 bg-line" aria-hidden="true" />
              ) : (
                <p className="px-2 pt-1 pb-1 text-xs font-medium tracking-wider text-ink-3 uppercase">
                  {group.label}
                </p>
              )}

              <ul className="space-y-px">
                {group.items.map((item) => {
                  // usePathname() excludes the query string, so /leads?lead=x
                  // still matches /leads. Every route here is one segment.
                  const active = pathname === item.href;
                  const Icon = item.icon;

                  const link = (
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex h-7 items-center gap-2.5 rounded-md px-2",
                        "transition-colors duration-(--duration-fast)",
                        collapsed && "justify-center px-0",
                        active
                          ? "bg-accent-soft font-medium text-ink"
                          : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                      )}
                    >
                      <Icon
                        size={15}
                        strokeWidth={1.75}
                        aria-hidden="true"
                        className={cn(
                          "shrink-0",
                          active ? "text-accent" : "text-ink-3",
                        )}
                      />
                      {!collapsed && (
                        <span className="min-w-0 flex-1 truncate">
                          {item.label}
                        </span>
                      )}
                      {item.badge === "alerts" && !collapsed && (
                        <AlertBadge initialCount={openAlerts} />
                      )}
                    </Link>
                  );

                  return (
                    <li key={item.href} className="relative">
                      {collapsed ? (
                        <Tooltip content={item.label} side="right" className="w-full">
                          {link}
                        </Tooltip>
                      ) : (
                        link
                      )}
                      {collapsed && item.badge === "alerts" && openAlerts > 0 && (
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute top-1 right-1.5 size-1.5 rounded-full bg-danger"
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className={cn("shrink-0 border-t border-line p-2", collapsed && "px-1.5")}>
          <UserMenu email={email} role={role} collapsed={collapsed} />
        </div>
      </aside>

      <CommandPalette />
    </>
  );
}
