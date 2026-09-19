import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Nothing here, and what to do about it.
 *
 * The app had about ten bare "Nothing yet." paragraphs, which tell an operator
 * the query ran and nothing else. An empty state that does not name the next
 * action is a dead end wearing a sentence.
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
  className,
  compact,
}: {
  icon?: ReactNode;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-1.5 px-4 py-8" : "gap-2 px-6 py-16",
        className,
      )}
    >
      {icon && (
        <span
          aria-hidden="true"
          className={cn(
            "mb-1 flex items-center justify-center rounded-lg border border-line bg-surface-2 text-ink-3",
            compact ? "size-8" : "size-10",
          )}
        >
          {icon}
        </span>
      )}
      <p className={cn("font-medium text-ink", !compact && "text-lg")}>
        {title}
      </p>
      {body && <p className="max-w-[46ch] text-ink-3">{body}</p>}
      {action && <div className="mt-2 flex items-center gap-2">{action}</div>}
    </div>
  );
}
