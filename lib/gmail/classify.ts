// What an inbound message means.
//
// Three outcomes matter, and status derivation halts the remaining sequence on
// any of them: replied, bounced, unsubscribed. Getting the distinction wrong is
// expensive in both directions — a bounce read as a reply looks like interest
// and stops nothing useful, and a real reply read as a bounce suppresses a
// prospect who just said yes.
//
// Pure, so it can be tested against real headers without a mailbox.

export type InboundKind = "reply" | "bounce" | "unsubscribe" | "ignore";

export interface Classification {
  kind: InboundKind;
  /**
   * Only meaningful for a bounce. A 5.x.x status is permanent and earns a
   * suppression; a 4.x.x is a full mailbox or a greylist and must not, or one
   * bad afternoon at the prospect's host takes them off the list forever.
   */
  hard: boolean;
  /** Why, for the event payload. Saves reconstructing the reasoning later. */
  reason: string;
}

export interface InboundMessage {
  labelIds: string[];
  headers: Record<string, string>;
  text: string;
  snippet: string;
}

const DAEMON =
  /(mailer-daemon|postmaster|no-?reply@.*(mail|delivery)|mail delivery (subsystem|system))/i;

/** A permanent SMTP failure. 5.x.x in a DSN, or the classic phrasings. */
const HARD_STATUS = /\bstatus:\s*5\.\d+\.\d+/i;
const SOFT_STATUS = /\bstatus:\s*4\.\d+\.\d+/i;
const HARD_PHRASES =
  /(user unknown|no such user|address (not found|does not exist)|recipient (address )?rejected|mailbox (unavailable|does not exist)|550[ -]5\.\d)/i;
const SOFT_PHRASES =
  /(over quota|mailbox full|temporar(y|ily)|try again later|greylist|4\.7\.\d|rate limit)/i;

/**
 * A delay notice is not a failure. Gmail's "Delivery incomplete ... Gmail will
 * retry for 47 more hours" carries a 4.x.x status, and read as a soft bounce it
 * halted the sequence for good, because status derivation halts on any
 * `bounced` event, hard or soft, for a message that usually arrives an hour
 * later. If the retries run out a second report follows with `Action: failed`,
 * and that one is the bounce.
 */
const DELAYED =
  /(\baction:\s*delayed\b|delivery status notification \(delay\)|delivery incomplete|will retry for)/i;
const FAILED_ACTION = /\baction:\s*failed\b/i;

const UNSUBSCRIBE =
  /(\bunsubscribe\b|take me off|remove (me|us)\b|opt(ed)? out|stop (emailing|contacting)|do not (email|contact)|no longer interested in receiving)/i;

/**
 * Auto-replies are not replies. An out-of-office that halted the sequence would
 * end an outreach attempt because somebody went on holiday.
 */
const AUTO_SUBMITTED = /auto-(replied|generated|notified)/i;
const VACATION_SUBJECT =
  /(out of (the )?office|automatic reply|auto[- ]?reply|away from my|on (vacation|leave|annual leave))/i;

/**
 * The words this person actually wrote, above whatever their client quoted.
 *
 * Needed the moment our own email carries a List-Unsubscribe header: a reply
 * that quotes the original, headers and all, puts the word "unsubscribe" in the
 * body of a message that says "sure, send it over", and the match below would
 * suppress a prospect who had just said yes. Quoting styles differ, so this cuts
 * at the first of: a ">" line (Gmail, Apple Mail), the "On ... wrote:"
 * attribution, an "Original message" separator, or Outlook's "From:" header
 * block.
 *
 * Only the reply/unsubscribe path uses it. A bounce is read from the WHOLE
 * message, because a DSN's status code lives inside the quoted report.
 */
export function newText(text: string): string {
  const lines = text.split(/\r?\n/);
  const cut = lines.findIndex(
    (line) =>
      /^\s*>/.test(line) ||
      /^\s*On\b.{0,300}(wrote:|<[^>\s]+@[^>\s]+>)\s*$/i.test(line) ||
      /^\s*wrote:\s*$/i.test(line) ||
      /^\s*[-_]{2,}\s*(original|forwarded) message/i.test(line) ||
      /^\s*From:\s*\S+/i.test(line),
  );
  return (cut === -1 ? lines : lines.slice(0, cut)).join("\n");
}

export function classifyInbound(message: InboundMessage): Classification {
  const { headers, labelIds } = message;
  const haystack = `${headers["subject"] ?? ""}\n${message.text}\n${message.snippet}`;

  // Our own outbound copy. Gmail files a sent message in the thread too.
  if (labelIds.includes("SENT") && !labelIds.includes("INBOX")) {
    return { kind: "ignore", hard: false, reason: "our own outbound copy" };
  }

  const from = headers["from"] ?? "";
  const contentType = headers["content-type"] ?? "";

  const looksLikeDsn =
    /report-type\s*=\s*"?delivery-status/i.test(contentType) ||
    headers["x-failed-recipients"] !== undefined ||
    DAEMON.test(from);

  if (looksLikeDsn) {
    // Order matters. A DSN often quotes the original message, which may itself
    // contain wording that matches a soft phrase, so the explicit machine
    // status is checked before any prose.
    if (HARD_STATUS.test(haystack)) {
      return { kind: "bounce", hard: true, reason: "DSN with a 5.x.x status" };
    }
    if (DELAYED.test(haystack) && !FAILED_ACTION.test(haystack)) {
      return { kind: "ignore", hard: false, reason: "delivery delayed, still being retried" };
    }
    if (SOFT_STATUS.test(haystack)) {
      return { kind: "bounce", hard: false, reason: "DSN with a 4.x.x status" };
    }
    if (SOFT_PHRASES.test(haystack)) {
      return { kind: "bounce", hard: false, reason: "temporary delivery failure" };
    }
    if (HARD_PHRASES.test(haystack)) {
      return { kind: "bounce", hard: true, reason: "permanent delivery failure" };
    }
    // A delivery report we cannot grade. Treated as soft: recording a bounce is
    // right, suppressing on a guess is not.
    return { kind: "bounce", hard: false, reason: "ungraded delivery report" };
  }

  // Only what they wrote, never what their client quoted back at us: our own
  // outbound carries a List-Unsubscribe header, and a reply quoting it is not a
  // request to be removed. The snippet loses its quoted tail for the same reason.
  const written = [
    headers["subject"] ?? "",
    newText(message.text),
    message.snippet.split(/\bOn\b.{0,200}\bwrote:/i)[0] ?? "",
  ].join("\n");

  // Checked before the auto-reply test on purpose. "Please unsubscribe me" sent
  // from an account with a vacation responder on is still an unsubscribe.
  if (UNSUBSCRIBE.test(written) || headers["list-unsubscribe"] !== undefined) {
    return { kind: "unsubscribe", hard: true, reason: "asked to be taken off" };
  }

  const autoSubmitted = headers["auto-submitted"] ?? "";
  if (
    AUTO_SUBMITTED.test(autoSubmitted) ||
    headers["x-autoreply"] !== undefined ||
    headers["x-autorespond"] !== undefined ||
    VACATION_SUBJECT.test(headers["subject"] ?? "")
  ) {
    return { kind: "ignore", hard: false, reason: "automatic reply" };
  }

  return { kind: "reply", hard: false, reason: "a person wrote back" };
}

/** The lead_event type an inbound message maps to, or null for ignore. */
export function eventTypeFor(kind: InboundKind): string | null {
  if (kind === "reply") return "replied";
  if (kind === "bounce") return "bounced";
  if (kind === "unsubscribe") return "unsubscribed";
  return null;
}
