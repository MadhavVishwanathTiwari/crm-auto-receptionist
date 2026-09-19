import { cn } from "@/lib/cn";

/** A key, as printed on a key. */
export function Kbd({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <kbd
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded-sm border border-line-2",
        "bg-surface-3 px-1 font-sans text-xs text-ink-3",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
