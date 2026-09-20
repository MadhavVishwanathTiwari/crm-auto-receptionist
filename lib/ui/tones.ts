/**
 * What a colour means, in one place.
 *
 * globals.css says colour encodes meaning and never decoration. That rule only
 * holds if there is a single table saying which meaning, which used to live in
 * app/(app)/ui.ts as three maps of raw class strings. Class strings cannot be
 * reused by a badge that wants a soft fill and a ring as well as text, so the
 * maps now name a TONE and each surface decides how to wear it.
 */

export type Tone =
  | "neutral"
  | "muted"
  | "accent"
  | "ok"
  | "warn"
  | "danger"
  | "info";

/** Lead status, as app.lead_status_from_events derives it. */
export const STATUS_TONE: Record<string, Tone> = {
  imported: "muted",
  qualified: "neutral",
  claimed: "info",
  audited: "info",
  queued: "info",
  sent: "neutral",
  delivered: "neutral",
  opened: "ok",
  replied: "ok",
  bounced: "danger",
  unsubscribed: "danger",
  closed_won: "ok",
  closed_lost: "muted",
  do_not_contact: "danger",
  // Not a status. The lead timeline colours event types from this map too, and
  // a refused demo build is the one event worth a warning there.
  demo_failed: "warn",
};

/**
 * Board columns. Same rule as STATUS_TONE: the live-conversation stages read
 * forward, nurture reads parked, and the two terminals keep the tone
 * close_lead() already gave them.
 */
export const STAGE_TONE: Record<string, Tone> = {
  prospect: "muted",
  engaged: "info",
  meeting: "ok",
  proposal: "ok",
  nurture: "warn",
  closed_won: "ok",
  closed_lost: "muted",
  do_not_contact: "danger",
};

/** What an import did with a row. */
export const OUTCOME_TONE: Record<string, Tone> = {
  inserted: "ok",
  skipped_duplicate: "muted",
  flagged_review: "warn",
  failed_validation: "danger",
};

/** An alert kind, as poll-replies and the reconciler write them. */
export const ALERT_TONE: Record<string, Tone> = {
  reply: "ok",
  bounce: "danger",
  unsubscribe: "danger",
  mailbox_auth: "danger",
  cap_exhausted: "warn",
  orphan_demo: "warn",
  pre_send_review: "warn",
  ai_reply: "info",
  send_failed: "danger",
};

/** Text only. The tone worn the way the old class-string maps wore it. */
export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-ink",
  muted: "text-ink-3",
  accent: "text-accent",
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  info: "text-info",
};

/** A filled chip: soft background, full-strength text. */
export const TONE_SOFT: Record<Tone, string> = {
  neutral: "bg-neutral-soft text-ink",
  muted: "bg-neutral-soft text-ink-3",
  accent: "bg-accent-soft text-accent",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
};

/** Just the dot, for a badge that wants the label in ordinary ink. */
export const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-ink-2",
  muted: "bg-ink-3",
  accent: "bg-accent",
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  info: "bg-info",
};

export function toneFor(
  map: Record<string, Tone>,
  key: string | null | undefined,
): Tone {
  return (key && map[key]) || "muted";
}

/** A status or stage as words rather than a database identifier. */
export function humanise(value: string | null | undefined): string {
  if (!value) return "—";
  return value.replace(/_/g, " ");
}
