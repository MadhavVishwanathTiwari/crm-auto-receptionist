// WHICH mailboxes a send is allowed to leave from.
//
// book.ts answers "which of these mailboxes has room, and when". It deliberately
// does not answer "which of these mailboxes is it *right* to use", and for a
// long time nothing did: pickMailbox() was handed every sendable mailbox in the
// org and returned the emptiest one. So an email Ojas wrote by hand, to a lead
// Ojas owned, went out from madhav@ whenever madhav@ had more headroom that day,
// and the prospect's reply landed in the wrong inbox.
//
// This file is the missing half. It narrows the candidate list BEFORE bookSlot
// sees it, which is why book.ts needed no change at all: buildCapacity() indexes
// every mailbox in the org, and pickMailbox() only ever iterates the array it is
// handed. Filtering the array is sufficient, and it keeps the cap arithmetic in
// exactly one place.
//
// Pure and synchronous, same as book.ts and slots.ts, and for the same reason:
// three callers depend on it agreeing with itself, and it is only honestly
// testable with no database and no clock.

import type { BookingMailbox } from "@/lib/scheduler/book";

/** A mailbox plus the operator it belongs to. Null means nobody owns it. */
export interface RoutedMailbox extends BookingMailbox {
  user_id: string | null;
}

/** The minimum of a scheduled_sends row needed to find a lead's pin. */
export interface PinCandidate {
  status: string;
  mailbox_id: string | null;
  step_number?: number | null;
}

export type RoutingReason = "pinned" | "owner";

export type RoutingBlock =
  /** The thread started on a mailbox that is now paused or disconnected. */
  | "pin_unavailable"
  /** Nobody has claimed the lead, so there is no operator to send as. */
  | "no_owner"
  /** The owner has not connected a mailbox, or it is paused. */
  | "owner_has_no_mailbox";

export type Routing<T extends RoutedMailbox> =
  | { ok: true; mailboxes: T[]; reason: RoutingReason; pinnedTo: T | null }
  | { ok: false; blocked: RoutingBlock };

/**
 * Which user ids may send from which mailbox.
 *
 * Normally one: the operator who connected it. It is a set rather than a single
 * id because one human can hold two accounts here -- madhav@autoreceptionist.io
 * connected the mailbox, madhav@tryautoreceptionist.com owns the leads -- and
 * app.operator_aliases has recorded them as the same person since 0026. The
 * resolution lives in SQL (public.mailbox_senders) so this file never has to
 * know what an alias is.
 */
export type MailboxSenders = Map<string, Set<string>>;

/**
 * The mailbox a lead's sequence is already committed to, if any.
 *
 * Any `sent` row pins the lead: dispatch-sends looks the prior Gmail threadId up
 * PER LEAD and hands it to whichever mailbox the next step routes to, and a
 * threadId is only meaningful inside the mailbox that issued it. Sending T2 from
 * a different account than T1 therefore does not merely look odd to the
 * prospect, it hands Gmail an id it has never heard of.
 *
 * The highest step wins so the answer is stable, though in practice every sent
 * row for one lead carries the same mailbox. Rows with a null mailbox_id are
 * ignored: 0027's sheet backfill writes those deliberately, because the sheet
 * never recorded which account sent the touch, and a lead whose only history is
 * backfilled is free to start fresh on its owner's mailbox.
 */
export function pinnedMailboxIdFor(sends: PinCandidate[]): string | null {
  let best: PinCandidate | null = null;

  for (const send of sends) {
    if (send.status !== "sent" || !send.mailbox_id) continue;
    if (!best || (send.step_number ?? 0) > (best.step_number ?? 0)) best = send;
  }

  return best?.mailbox_id ?? null;
}

function ownedBy<T extends RoutedMailbox>(
  mailbox: T,
  ownerId: string,
  senders: MailboxSenders | undefined,
): boolean {
  // Exact ownership first, always. It is the strongest evidence there is, and
  // 0026 settled the same question the same way for the import.
  if (mailbox.user_id === ownerId) return true;

  return senders?.get(mailbox.id)?.has(ownerId) ?? false;
}

/**
 * The mailboxes this send may use, narrowed from everything the org has.
 *
 * In priority order:
 *
 *   1. Pinned    the mailbox a prior touch already went out from. That one and
 *                nothing else, even if the lead has since been reassigned: the
 *                prospect has a thread, and it lives in that account.
 *   2. Owner     the mailboxes belonging to whoever claimed the lead. Several is
 *                fine; pickMailbox still spreads across them by capacity.
 *   3. Refused   never somebody else's address. Falling back to the org pool is
 *                precisely the bug this exists to make impossible.
 *
 * A pinned mailbox with no room today is NOT a refusal -- bookSlot walks on to
 * tomorrow, which is the correct answer for a follow-up.
 */
export function mailboxesForSend<T extends RoutedMailbox>(
  all: T[],
  opts: {
    /** leads.claimed_by. */
    ownerId: string | null;
    pinnedMailboxId: string | null;
    senders?: MailboxSenders;
  },
): Routing<T> {
  if (opts.pinnedMailboxId) {
    const pinned = all.find((m) => m.id === opts.pinnedMailboxId);
    // Absent from the sendable list means paused or disconnected. Blocking is
    // right: the alternative is silently breaking the thread.
    if (!pinned) return { ok: false, blocked: "pin_unavailable" };
    return { ok: true, mailboxes: [pinned], reason: "pinned", pinnedTo: pinned };
  }

  if (!opts.ownerId) return { ok: false, blocked: "no_owner" };

  const owned = all.filter((m) => ownedBy(m, opts.ownerId!, opts.senders));
  if (owned.length === 0) return { ok: false, blocked: "owner_has_no_mailbox" };

  return { ok: true, mailboxes: owned, reason: "owner", pinnedTo: null };
}

/** Turns the senders RPC's flat rows into the map mailboxesForSend wants. */
export function buildMailboxSenders(
  rows: { mailbox_id: string; user_id: string }[],
): MailboxSenders {
  const senders: MailboxSenders = new Map();

  for (const row of rows) {
    const set = senders.get(row.mailbox_id);
    if (set) set.add(row.user_id);
    else senders.set(row.mailbox_id, new Set([row.user_id]));
  }

  return senders;
}
