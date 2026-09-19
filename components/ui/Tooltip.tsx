"use client";

import { useId, useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * A label for something that only shows an icon.
 *
 * Hover and focus both, because the collapsed sidebar is reachable from the
 * keyboard and a tooltip only a mouse can open is not a label.
 */
export function Tooltip({
  content,
  side = "right",
  children,
  className,
}: {
  content: ReactNode;
  side?: "right" | "top" | "bottom";
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);

  return (
    <span
      className={cn("relative inline-flex", className)}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={() => setOpen(false)}
    >
      <span aria-describedby={open ? id : undefined} className="inline-flex">
        {children}
      </span>
      {open && (
        <span
          id={id}
          role="tooltip"
          className={cn(
            "pointer-events-none absolute z-50 rounded-md border border-line-2 bg-surface-4",
            "px-2 py-1 whitespace-nowrap text-ink shadow-lg",
            side === "right" && "top-1/2 left-[calc(100%+8px)] -translate-y-1/2",
            side === "top" && "bottom-[calc(100%+6px)] left-1/2 -translate-x-1/2",
            side === "bottom" && "top-[calc(100%+6px)] left-1/2 -translate-x-1/2",
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}
