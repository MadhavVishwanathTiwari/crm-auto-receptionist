import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Every page is a full-height column whose body owns its own scrolling.
 * body { overflow: hidden } in globals.css is the other half of that contract:
 * the page itself must never scroll, horizontally or otherwise.
 */
export function Page({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex h-full flex-col overflow-hidden", className)}>
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  meta,
  actions,
  note,
  className,
}: {
  title: ReactNode;
  /** A count or short status that belongs beside the title. */
  subtitle?: ReactNode;
  /** Secondary line under the title. */
  meta?: ReactNode;
  actions?: ReactNode;
  /** The right-aligned editorial one-liner this app uses on most screens. */
  note?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex shrink-0 items-center gap-3 border-b border-line bg-surface px-4 py-2.5",
        className,
      )}
    >
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <h1 className="truncate text-xl font-semibold text-ink">{title}</h1>
          {subtitle && (
            <span className="tabular shrink-0 text-ink-3">{subtitle}</span>
          )}
        </div>
        {meta && <p className="mt-0.5 truncate text-ink-3">{meta}</p>}
      </div>

      {note && (
        <p className="ml-auto hidden max-w-[42ch] truncate text-ink-3 xl:block">
          {note}
        </p>
      )}

      {actions && (
        <div
          className={cn(
            "flex shrink-0 items-center gap-2",
            note ? "ml-3" : "ml-auto",
          )}
        >
          {actions}
        </div>
      )}
    </header>
  );
}

/**
 * The scrolling region. `comfortable` is the 14px step: forms, detail panels
 * and dashboards opt into it, while grids stay on the 13px base so their row
 * height -- which the virtualizer depends on -- does not move.
 */
export function PageBody({
  density = "comfortable",
  width,
  className,
  children,
}: {
  density?: "compact" | "comfortable";
  /** Caps the reading width, as most of the non-grid screens want. */
  width?: "prose" | "wide" | "full";
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "min-h-0 flex-1 overflow-y-auto",
        density === "comfortable" && "text-lg",
        className,
      )}
    >
      <div
        className={cn(
          "p-4",
          width === "prose" && "mx-auto max-w-[900px]",
          width === "wide" && "mx-auto max-w-[1280px]",
        )}
      >
        {children}
      </div>
    </div>
  );
}
