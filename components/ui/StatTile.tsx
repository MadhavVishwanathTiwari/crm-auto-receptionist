import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { TONE_TEXT, type Tone } from "@/lib/ui/tones";

/**
 * A labelled number with actual hierarchy.
 *
 * The old Stat rendered its label, its value and its detail at the same 13px,
 * so a dashboard of them read as a wall of sentences rather than as figures.
 * The value is the thing somebody came to the screen for; it gets the size.
 */
export function StatTile({
  label,
  value,
  tone = "neutral",
  detail,
  icon,
  className,
  size = "md",
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: Tone;
  detail?: ReactNode;
  icon?: ReactNode;
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <div className={cn("min-w-[124px]", className)}>
      <p className="flex items-center gap-1.5 text-xs tracking-wide text-ink-3 uppercase">
        {icon}
        {label}
      </p>
      {/* One colour class, never two: Tailwind utilities for the same property
          have equal specificity, so a base plus an override is decided by the
          order rules land in the stylesheet. cn() settles it by dropping the
          loser, but naming one tone is still clearer than relying on that. */}
      <p
        className={cn(
          "tabular mt-0.5 font-semibold",
          size === "lg" ? "text-3xl" : size === "sm" ? "text-xl" : "text-2xl",
          TONE_TEXT[tone],
        )}
      >
        {value}
      </p>
      {detail && <p className="mt-0.5 text-ink-3">{detail}</p>}
    </div>
  );
}
