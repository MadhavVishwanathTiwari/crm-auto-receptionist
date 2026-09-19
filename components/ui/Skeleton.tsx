import { cn } from "@/lib/cn";

/**
 * A placeholder while the server works. Every page in (app) is force-dynamic,
 * so without one the browser sits on the PREVIOUS page and the click reads as
 * dead. Perceived speed was a bigger share of "this app is slow" than any
 * single query.
 */
export function Skeleton({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      aria-hidden="true"
      style={style}
      className={cn(
        "animate-pulse rounded-sm bg-surface-2",
        // Ragged rather than uniform: a column of identical bars reads as a
        // rendering bug, a ragged one reads as text that has not arrived.
        className,
      )}
    />
  );
}

/** The list-shaped skeleton most screens want. */
export function SkeletonRows({
  rows = 12,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1", className)} aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton
          key={index}
          className="h-(--row-height)"
          style={{ width: `${88 - ((index * 7) % 34)}%` }}
        />
      ))}
    </div>
  );
}
