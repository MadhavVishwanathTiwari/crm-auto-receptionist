// One skeleton for every page in the group.
//
// Every page here is `dynamic = "force-dynamic"`, so a navigation cannot be
// served from a cache and always waits on the server. Without a loading state
// Next has nothing to show while it waits, so the browser sits on the PREVIOUS
// page with no feedback at all — which reads as a dead click rather than as a
// slow one. That is most of why this app felt slow even on the requests that
// were not.
//
// Deliberately generic: the pages share a header and a dense body, and a
// per-page skeleton that guesses the wrong shape is worse than an honest one.
// No animation — a pulse on a black grid at 13px is noise, and the whole point
// is to signal "working" without pretending to be content.

import { PAGE, PAGE_HEADER } from "./ui";

/** Enough rows to fill a laptop viewport at --row-height. */
const ROWS = 18;

export default function Loading() {
  return (
    <div className={PAGE} aria-busy="true">
      <header className={PAGE_HEADER}>
        <span className="text-[var(--color-ink-3)]">Loading</span>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden p-4">
        <div className="flex flex-col gap-2">
          {Array.from({ length: ROWS }, (_, index) => (
            <div
              key={index}
              className="h-[var(--row-height)] bg-[var(--color-surface)]"
              // Ragged widths so it reads as rows of text rather than as a
              // block that failed to load.
              style={{ width: `${88 - ((index * 7) % 34)}%` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
