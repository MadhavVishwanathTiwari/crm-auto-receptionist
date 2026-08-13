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

const UNSUBSCRIBE =
  /(\bunsubscribe\b|take me off|remove me from|opt(ed)? out|stop (emailing|contacting)|do not (email|contact)|no longer interested in receiving)/i;

/**
 * Auto-replies are not replies. An out-of-office that halted the sequence would
 * end an outreach attempt because somebody went on holiday.
 */
const AUTO_SUBMITTED = /auto-(replied|generated|notified)/i;
const VACATION_SUBJECT =
  /(out of (the )?office|automatic reply|auto[- ]?reply|away from my|on (vacation|leave|annual leave))/i;

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

  // Checked before the auto-reply test on purpose. "Please unsubscribe me" sent
  // from an account with a vacation responder on is still an unsubscribe.
  if (UNSUBSCRIBE.test(haystack) || headers["list-unsubscribe"] !== undefined) {
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
