import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * A fact about a record. The write rail and the lead drawer each had their own
 * copy of this row, under two different names (Fact and Field).
 */
export function KeyValue({
  label,
  children,
  className,
  wide,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
  wide?: boolean;
}) {
  return (
    <div className={cn("flex gap-3 py-1", className)}>
      <dt
        className={cn("shrink-0 text-ink-3", wide ? "w-32" : "w-24")}
      >
        {label}
      </dt>
      <dd className="min-w-0 flex-1 text-ink-2">{children}</dd>
    </div>
  );
}

export function KeyValueList({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <dl className={cn("divide-y divide-line/60", className)}>{children}</dl>;
}
