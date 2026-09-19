import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { TONE_DOT, TONE_SOFT, TONE_TEXT, type Tone } from "@/lib/ui/tones";

export interface BadgeProps {
  tone?: Tone;
  /**
   * soft  - filled chip, for a status that should be findable at a glance
   * dot   - a coloured dot beside ordinary ink, for dense rows
   * text  - colour only, which is what the app did everywhere before badges
   */
  variant?: "soft" | "dot" | "text" | "outline";
  className?: string;
  children: ReactNode;
}

export function Badge({
  tone = "muted",
  variant = "soft",
  className,
  children,
}: BadgeProps) {
  if (variant === "dot") {
    return (
      <span className={cn("inline-flex items-center gap-1.5", className)}>
        <span
          aria-hidden="true"
          className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone])}
        />
        <span className="truncate">{children}</span>
      </span>
    );
  }

  if (variant === "text") {
    return (
      <span className={cn("truncate", TONE_TEXT[tone], className)}>
        {children}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-sm px-1.5 py-px",
        "text-xs font-medium whitespace-nowrap first-letter:uppercase",
        variant === "outline"
          ? cn("border border-current/30", TONE_TEXT[tone])
          : TONE_SOFT[tone],
        className,
      )}
    >
      <span className="truncate">{children}</span>
    </span>
  );
}
