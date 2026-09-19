"use client";

import { useEffect } from "react";

/**
 * Escape, without the two-things-at-once bug.
 *
 * Three screens bind their own window keydown listener and navigate away on
 * Escape: the lead drawer, the contact card and the pipeline board's pending
 * close. They are right to -- none of them is a modal, they are flex siblings
 * driven by a URL parameter, so the platform will not close them.
 *
 * But the moment an overlay is open on one of those screens -- a confirm
 * dialog, a menu, the command palette -- one Escape would dismiss the overlay
 * AND navigate the drawer away behind it. The convention here is the one the
 * platform and every overlay library use: whatever consumes an Escape marks it
 * consumed, and listeners further out check before acting.
 *
 * Overlays in components/ui do both: stopPropagation, so the event never
 * reaches window at all, and preventDefault, so anything listening in the
 * capture phase still sees that it was handled.
 */
export function useEscape(
  onEscape: () => void,
  { enabled = true }: { enabled?: boolean } = {},
): void {
  useEffect(() => {
    if (!enabled) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (event.defaultPrevented) return;
      onEscape();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onEscape, enabled]);
}
