// Reading a conversation, without judging it.
//
// Three questions, all of them answered from one threads.get and none of them
// answerable from this database:
//
//   - has one of us already replied? An operator answering from their own Gmail
//     writes nothing here. The Sent copy in the thread is the only evidence
//     that exists, and it is the whole "were we more than five minutes late"
//     test. Note the corollary: a Gmail threadId only exists inside the account
//     that issued it, so if an operator answers from the OTHER mailbox this
//     cannot see it. That is narrow -- a thread is pinned to one mailbox from
//     its first touch -- but it is the one hole in the test.
//   - has the prospect written again? Two messages is a conversation, and a
//     conversation is a person's job.
//   - what was actually said, with each side's quoted history cut off so the
//     model reads what people wrote rather than four copies of our own email.
//
// Pure and import-free, like classify.ts: testable against real payloads with
// no mailbox, and loadable by a script under Node's type stripping.

export interface ThreadMessage {
  id: string;
  labelIds: string[];
  /** Epoch millis as a string, which is how Gmail sends it. */
  internalDate: string | null;
  headers: Record<string, string>;
  text: string;
}

export type Direction = "us" | "them";

export interface TranscriptEntry {
  direction: Direction;
  /** ISO, or null when Gmail gave no internalDate. */
  at: string | null;
  subject: string | null;
  text: string;
}

/** Gmail files our own outbound copy into the thread, labelled SENT. */
export function isOutbound(message: ThreadMessage): boolean {
  return message.labelIds.includes("SENT");
}

function receivedAt(message: ThreadMessage): number {
  const value = Number(message.internalDate ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/**
 * The message with this id, or null when it has been deleted since.
 *
 * Generic so a caller holding richer messages -- GmailMessage, say -- gets one
 * of those back rather than the narrowed shape this file needs.
 */
export function findMessage<T extends ThreadMessage>(
  messages: T[],
  messageId: string,
): T | null {
  return messages.find((message) => message.id === messageId) ?? null;
}

/**
 * Did anything leave this mailbox after the message we are answering?
 *
 * Strictly after, by internalDate. Equal timestamps mean Gmail recorded both in
 * the same millisecond, which for an inbound and an outbound is not something
 * that happens; treating equal as "already answered" would make the assistant
 * silently skip rather than risk one it should have taken.
 */
export function humanRepliedAfter(
  messages: ThreadMessage[],
  inboundId: string,
): boolean {
  const inbound = findMessage(messages, inboundId);
  if (!inbound) return false;
  const at = receivedAt(inbound);
  return messages.some(
    (message) => isOutbound(message) && receivedAt(message) > at,
  );
}

/** Did the prospect write again after the message we are answering? */
export function newerInboundAfter(
  messages: ThreadMessage[],
  inboundId: string,
): boolean {
  const inbound = findMessage(messages, inboundId);
  if (!inbound) return false;
  const at = receivedAt(inbound);
  return messages.some(
    (message) =>
      !isOutbound(message) &&
      message.id !== inboundId &&
      receivedAt(message) > at,
  );
}

export interface TranscriptOptions {
  /** How many messages, counting back from the newest. */
  limit: number;
  /** Per message. A quoted newsletter should not cost a thousand tokens. */
  maxChars: number;
  /**
   * What each person wrote, above whatever their client quoted. Pass
   * `newText` from ./classify -- taken as an argument so this file keeps no
   * imports, the same bargain touches.ts makes with the email normalizer.
   */
  stripQuotes: (text: string) => string;
}

/**
 * The conversation as the model should read it: oldest first, newest last.
 *
 * Oldest first because that is the order it happened in and the order a person
 * reads a thread. Taking the LAST `limit` messages rather than the first is the
 * point -- if a thread is long, the end is what is being answered.
 */
export function transcriptFor(
  messages: ThreadMessage[],
  options: TranscriptOptions,
): TranscriptEntry[] {
  const recent = messages.slice(Math.max(0, messages.length - options.limit));

  return recent.map((message) => {
    const stripped = options.stripQuotes(message.text).trim();
    const at = message.internalDate
      ? new Date(Number(message.internalDate)).toISOString()
      : null;

    return {
      direction: isOutbound(message) ? "us" : "them",
      at,
      subject: message.headers["subject"] ?? null,
      text:
        stripped.length > options.maxChars
          ? `${stripped.slice(0, options.maxChars)}\n[…truncated]`
          : stripped,
    };
  });
}
