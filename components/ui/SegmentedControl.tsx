"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface Segment<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  count?: number;
}

/**
 * A small set of mutually exclusive choices, shown rather than hidden.
 *
 * The leads grid asked "Everyone / Mine / Unclaimed pool" through a <select>,
 * which costs a click to find out what the options even are. Three visible
 * buttons is the same decision with none of the clicks.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Segment<T>[];
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-0.5 rounded-md border border-line bg-surface-2 p-0.5",
        className,
      )}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex h-6 cursor-pointer items-center gap-1.5 rounded-sm px-2.5 font-medium",
              "transition-colors duration-(--duration-fast)",
              selected
                ? "bg-surface-4 text-ink shadow-sm"
                : "text-ink-3 hover:text-ink-2",
            )}
          >
            {option.icon}
            {option.label}
            {option.count !== undefined && (
              <span className="tabular text-ink-3">{option.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
