// Which leads a mailbox's Sent folder wrote to, and how many touches that was.
//
// Shared by the nightly catch-up (app/api/cron/reconcile-mailboxes) and the
// one-off reconciliation (scripts/reconcile-mailbox-history.mjs). That is why it
// imports nothing: the script loads it as TypeScript under Node's type
// stripping, where a path alias or an extensionless import stops it loading.
// The normalizer is passed in for the same reason, so an address is still
// matched by the app's one normalizeEmail() and not by a copy.

/** One Sent-folder message, in the shape record_mailbox_touches() (0042) takes. */
export interface SentTouch {
  message_id: string;
  thread_id: string | null;
  rfc822_id: string | null;
  subject: string | null;
  mailbox_id: string;
  /** When Gmail says it left, as an ISO instant. */
  sent_at: string;
}

type Normalize = (address: string) => string | null;

const ADDRESS = /[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/g;

/** Every address in these header values or texts, normalized, once each. */
export function addressesIn(
  normalize: Normalize,
  ...values: (string | null | undefined)[]
): string[] {
  const found = values.flatMap((value) => (value ?? "").match(ADDRESS) ?? []);
  const normalized = found
    .map((address) => normalize(address))
    .filter((address): address is string => Boolean(address));
  return [...new Set(normalized)];
}

/** Everyone a sent message went to: To, Cc and Bcc. Headers keyed lowercase. */
export function recipientsOf(
  headers: Record<string, string>,
  normalize: Normalize,
): string[] {
  return addressesIn(normalize, headers["to"], headers["cc"], headers["bcc"]);
}

/** A touch from a message's metadata. Null if Gmail gave no send time. */
export function touchFrom(
  message: {
    id: string;
    threadId?: string | null;
    internalDate?: string | null;
    headers: Record<string, string>;
  },
  mailboxId: string,
): SentTouch | null {
  const millis = Number(message.internalDate);
  if (!message.internalDate || !Number.isFinite(millis)) return null;

  return {
    message_id: message.id,
    thread_id: message.threadId || null,
    rfc822_id: message.headers["message-id"] || null,
    subject: message.headers["subject"] || null,
    mailbox_id: mailboxId,
    sent_at: new Date(millis).toISOString(),
  };
}

/**
 * One touch per prospect-local day, the LATEST of that day, oldest day first.
 *
 * On Sep 10 the 0040 loop sent some leads three different first touches inside
 * three hours under three different subjects, so a subject is no key, and no
 * real sequence has ever put two touches on one day. The latest is also the
 * attempt 0040's repair recorded, so it matches that row instead of lending it
 * another email's thread.
 */
export function collapseToDays(touches: SentTouch[], zone: string | null): SentTouch[] {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const byDay = new Map<string, SentTouch>();
  const ordered = [...touches].sort((a, b) => a.sent_at.localeCompare(b.sent_at));
  for (const touch of ordered) byDay.set(day.format(new Date(touch.sent_at)), touch);

  return [...byDay.values()];
}
