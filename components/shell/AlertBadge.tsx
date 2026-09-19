"use client";

import { useEffect, useState } from "react";

import { createBrowserSupabase, subscribeAsUser } from "@/lib/supabase/client";

/**
 * The open-alert count, kept honest.
 *
 * The server count seeds it, but a layout is not re-rendered when the operator
 * moves between pages, so acknowledging an alert on /alerts used to leave the
 * number in the chrome stale until a hard reload. Realtime is the same
 * subscription /alerts itself uses, and it adds no query: the count arrives
 * with the layout it already fetches.
 */
export function AlertBadge({ initialCount }: { initialCount: number }) {
  const [count, setCount] = useState(initialCount);

  // The server is the authority whenever it re-renders (a full navigation, or
  // a revalidatePath after an acknowledge).
  const [seed, setSeed] = useState(initialCount);
  if (seed !== initialCount) {
    setSeed(initialCount);
    setCount(initialCount);
  }

  useEffect(() => {
    const supabase = createBrowserSupabase();
    const channel = supabase.channel("alert-badge").on(
      "postgres_changes",
      { event: "*", schema: "public", table: "alerts" },
      (payload) => {
        const before = payload.old as { acknowledged_at?: string | null } | null;
        const after = payload.new as { acknowledged_at?: string | null } | null;

        if (payload.eventType === "INSERT") {
          if (after && !after.acknowledged_at) setCount((n) => n + 1);
          return;
        }
        if (payload.eventType === "UPDATE" && before && after) {
          const wasOpen = !before.acknowledged_at;
          const isOpen = !after.acknowledged_at;
          if (wasOpen && !isOpen) setCount((n) => Math.max(0, n - 1));
          if (!wasOpen && isOpen) setCount((n) => n + 1);
        }
      },
    );

    return subscribeAsUser(supabase, channel);
  }, []);

  if (count <= 0) return null;

  return (
    <span
      aria-live="polite"
      aria-label={`${count} open ${count === 1 ? "alert" : "alerts"}`}
      className="tabular ml-auto shrink-0 rounded-sm bg-danger-soft px-1.5 py-px text-xs font-medium text-danger"
    >
      {count}
    </span>
  );
}
