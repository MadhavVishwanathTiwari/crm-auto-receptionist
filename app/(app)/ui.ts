// Shared class strings for the app chrome.
//
// Not a component library: four pages share a handful of surfaces and controls,
// and repeating the same twelve Tailwind utilities in each one is how they
// quietly drift apart.

export const BUTTON =
  "border border-[var(--color-line-2)] bg-[var(--color-surface-3)] px-3 py-1 " +
  "text-[var(--color-ink)] hover:border-[var(--color-line-strong)] " +
  "disabled:opacity-40 disabled:hover:border-[var(--color-line-2)]";

export const BUTTON_QUIET =
  "border border-transparent px-2 py-0.5 text-[var(--color-ink-2)] " +
  "hover:border-[var(--color-line-2)] hover:text-[var(--color-ink)] " +
  "disabled:opacity-40";

export const INPUT =
  "bg-[var(--color-surface-2)] border border-[var(--color-line)] px-2 py-1 " +
  "text-[var(--color-ink)] placeholder:text-[var(--color-ink-3)] " +
  "focus:border-[var(--color-focus)]";

export const PANEL =
  "border border-[var(--color-line)] bg-[var(--color-surface)] p-4";

/** Every page is a full-height column whose body owns its own scrolling. */
export const PAGE = "flex h-full flex-col overflow-hidden";

export const PAGE_HEADER =
  "flex shrink-0 items-center gap-3 border-b border-[var(--color-line)] px-4 py-2";

/** Colour only ever encodes meaning, per the design note in globals.css. */
export const STATUS_TONE: Record<string, string> = {
  imported: "text-[var(--color-ink-3)]",
  qualified: "text-[var(--color-ink-2)]",
  claimed: "text-[var(--color-info)]",
  audited: "text-[var(--color-info)]",
  queued: "text-[var(--color-info)]",
  sent: "text-[var(--color-ink)]",
  delivered: "text-[var(--color-ink)]",
  opened: "text-[var(--color-ok)]",
  replied: "text-[var(--color-ok)]",
  bounced: "text-[var(--color-danger)]",
  unsubscribed: "text-[var(--color-danger)]",
  closed_won: "text-[var(--color-ok)]",
  closed_lost: "text-[var(--color-ink-3)]",
  do_not_contact: "text-[var(--color-danger)]",
};

export const OUTCOME_TONE: Record<string, string> = {
  inserted: "text-[var(--color-ok)]",
  skipped_duplicate: "text-[var(--color-ink-3)]",
  flagged_review: "text-[var(--color-warn)]",
  failed_validation: "text-[var(--color-danger)]",
};

/**
 * Board columns. Same rule as STATUS_TONE: colour encodes meaning, so the
 * live-conversation stages read forward, nurture reads parked, and the two
 * terminals keep the tone close_lead() already gave them.
 */
export const STAGE_TONE: Record<string, string> = {
  prospect: "text-[var(--color-ink-3)]",
  engaged: "text-[var(--color-info)]",
  meeting: "text-[var(--color-ok)]",
  proposal: "text-[var(--color-ok)]",
  nurture: "text-[var(--color-warn)]",
  closed_won: "text-[var(--color-ok)]",
  closed_lost: "text-[var(--color-ink-3)]",
  do_not_contact: "text-[var(--color-danger)]",
};
