"use client";

import { cn } from "@/lib/cn";

export interface Tab<T extends string> {
  value: T;
  label: string;
  count?: number;
}

/** Sections of one record, where showing all of them at once would be a wall. */
export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  ariaLabel,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  tabs: Tab<T>[];
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn("flex items-center gap-4 border-b border-line", className)}
      onKeyDown={(event) => {
        const index = tabs.findIndex((tab) => tab.value === value);
        if (event.key === "ArrowRight") {
          event.preventDefault();
          onChange(tabs[(index + 1) % tabs.length]!.value);
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onChange(tabs[(index - 1 + tabs.length) % tabs.length]!.value);
        }
      }}
    >
      {tabs.map((tab) => {
        const selected = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.value)}
            className={cn(
              "-mb-px cursor-pointer border-b-2 px-0.5 pb-1.5 font-medium",
              "transition-colors duration-(--duration-fast)",
              selected
                ? "border-accent text-ink"
                : "border-transparent text-ink-3 hover:text-ink-2",
            )}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className="tabular ml-1.5 text-ink-3">{tab.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
