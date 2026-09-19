import { TriangleAlert } from "lucide-react";

import { EmptyState } from "./EmptyState";

/**
 * A query that failed, said the same way on every screen.
 *
 * These are server-side read failures, not action results, so they are not
 * toast candidates -- there is nothing on the page behind them to go back to.
 * There were a dozen hand-written variants of this paragraph.
 */
export function LoadError({
  what,
  message,
  compact,
}: {
  /** Reads as "Could not load {what}". */
  what: string;
  message?: string;
  compact?: boolean;
}) {
  return (
    <EmptyState
      compact={compact}
      icon={<TriangleAlert size={18} className="text-danger" />}
      title={`Could not load ${what}`}
      body={message ?? "The server did not say why."}
    />
  );
}
