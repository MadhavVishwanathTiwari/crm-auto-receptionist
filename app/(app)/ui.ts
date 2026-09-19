// Shared class strings for the app chrome.
//
// Not a component library: four pages share a handful of surfaces and controls,
// and repeating the same twelve Tailwind utilities in each one is how they
// quietly drift apart.

export const BUTTON =
  "border border-line-2 bg-surface-3 px-3 py-1 " +
  "text-ink hover:border-line-strong " +
  "disabled:opacity-40 disabled:hover:border-line-2";

export const BUTTON_QUIET =
  "border border-transparent px-2 py-0.5 text-ink-2 " +
  "hover:border-line-2 hover:text-ink " +
  "disabled:opacity-40";

export const INPUT =
  "bg-surface-2 border border-line px-2 py-1 " +
  "text-ink placeholder:text-ink-3 " +
  "focus:border-focus";

export const PANEL =
  "border border-line bg-surface p-4";

/** Every page is a full-height column whose body owns its own scrolling. */
export const PAGE = "flex h-full flex-col overflow-hidden";

export const PAGE_HEADER =
  "flex shrink-0 items-center gap-3 border-b border-line px-4 py-2";

/** Colour only ever encodes meaning, per the design note in globals.css. */
export const STATUS_TONE: Record<string, string> = {
  imported: "text-ink-3",
  qualified: "text-ink-2",
  claimed: "text-info",
  audited: "text-info",
  queued: "text-info",
  sent: "text-ink",
  delivered: "text-ink",
  opened: "text-ok",
  replied: "text-ok",
  bounced: "text-danger",
  unsubscribed: "text-danger",
  closed_won: "text-ok",
  closed_lost: "text-ink-3",
  do_not_contact: "text-danger",
  // Not a status. The lead timeline colours event types from this map too,
  // and a refused demo build is the one event worth a warning there.
  demo_failed: "text-warn",
};

export const OUTCOME_TONE: Record<string, string> = {
  inserted: "text-ok",
  skipped_duplicate: "text-ink-3",
  flagged_review: "text-warn",
  failed_validation: "text-danger",
};

/**
 * Board columns. Same rule as STATUS_TONE: colour encodes meaning, so the
 * live-conversation stages read forward, nurture reads parked, and the two
 * terminals keep the tone close_lead() already gave them.
 */
export const STAGE_TONE: Record<string, string> = {
  prospect: "text-ink-3",
  engaged: "text-info",
  meeting: "text-ok",
  proposal: "text-ok",
  nurture: "text-warn",
  closed_won: "text-ok",
  closed_lost: "text-ink-3",
  do_not_contact: "text-danger",
};
