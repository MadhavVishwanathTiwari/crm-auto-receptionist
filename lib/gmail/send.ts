// Building an RFC 5322 message and handing it to Gmail.
//
// multipart/alternative: the plain text, and the same words as bare HTML so a
// link can carry words instead of its address (./body.ts). That is the shape
// Gmail's own composer gives an email somebody typed. What stays out is the
// deliverability decision: no styling, no images, no tracking pixel and no
// redirect on a link. A cold first touch that looks like a newsletter gets filed
// like one, and the reply rate is the only metric this pipeline has.

import { randomUUID } from "node:crypto";

import { toHtml, toPlainText } from "./body";
import { fetchMessageMetadata } from "./messages";

const SEND_ENDPOINT =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export class GmailSendError extends Error {
  readonly status: number;
  /** Worth another attempt on a later run. A 4xx that is not 429 is not. */
  readonly retryable: boolean;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GmailSendError";
    this.status = status;
    this.retryable = status === 429 || status >= 500;
  }
}

export interface Address {
  name: string | null;
  email: string;
}

export interface MessageInput {
  from: Address;
  to: Address;
  subject: string;
  body: string;
  /**
   * The Message-ID header we write. Gmail replaces it with its own on send, so
   * this is never what the prospect receives; sendMessage() reads the real one
   * back and that is the one recorded.
   */
  messageId: string;
  /** The previous touch's Message-ID, when this is a follow-up. */
  inReplyTo?: string | null;
  references?: string[];
}

const ASCII_ONLY = /^[\x20-\x7E]*$/;

/**
 * RFC 2047 for anything that is not plain ASCII.
 *
 * Company names in this ICP carry accents and the occasional emoji, and a
 * raw UTF-8 subject header is not merely non-compliant — Gmail renders it as
 * mojibake, which is the first thing the prospect sees.
 */
function encodeHeaderValue(value: string): string {
  if (ASCII_ONLY.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function formatAddress(address: Address): string {
  if (!address.name) return address.email;
  return `${encodeHeaderValue(`"${address.name.replace(/"/g, "")}"`)} <${address.email}>`;
}

/** `<uuid@domain>`, where the domain is the sending mailbox's own. */
export function generateMessageId(senderEmail: string): string {
  const domain = senderEmail.split("@")[1] ?? "localhost";
  return `<${randomUUID()}@${domain}>`;
}

/** CRLF, then base64 in 76-column lines. */
function encodeBody(text: string): string {
  return Buffer.from(text.replace(/\r?\n/g, "\r\n"), "utf8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n");
}

/**
 * The raw message.
 *
 * CRLF line endings throughout, and each part is base64 so a long line, a stray
 * bare newline or a leading "From " in the copy cannot corrupt the message.
 * Plain text first: in multipart/alternative the last part is the preferred
 * one, and a client that cannot show HTML falls back to the first.
 */
export function buildMimeMessage(input: MessageInput): string {
  const boundary = `=_ar_${randomUUID()}`;
  const headers: string[] = [
    `From: ${formatAddress(input.from)}`,
    `To: ${formatAddress(input.to)}`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    // An "Unsubscribe" link next to our name, so somebody who wants out presses
    // that rather than "Report spam". A spam report costs the sending domain's
    // reputation for every later prospect; an unsubscribe costs one lead. The
    // address is the sending mailbox itself, so the request lands in the same
    // inbox poll-replies already reads and classifyInbound() files as an
    // unsubscribe. No https form, so no List-Unsubscribe-Post: one-click needs
    // an endpoint that acts without a human, and a mailto Gmail sends for the
    // reader is the same promise without one.
    `List-Unsubscribe: <mailto:${input.from.email}?subject=unsubscribe>`,
    `Message-ID: ${input.messageId}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  if (input.inReplyTo) {
    headers.push(`In-Reply-To: ${input.inReplyTo}`);
    // References carries the whole chain, oldest first. Gmail threads on it,
    // and so does every other client the prospect might be using.
    const chain = [...(input.references ?? []), input.inReplyTo];
    headers.push(`References: ${[...new Set(chain)].join(" ")}`);
  }

  const part = (type: string, text: string) =>
    [
      `--${boundary}`,
      `Content-Type: ${type}; charset="UTF-8"`,
      "Content-Transfer-Encoding: base64",
      "",
      encodeBody(text),
    ].join("\r\n");

  return [
    headers.join("\r\n"),
    "",
    part("text/plain", toPlainText(input.body)),
    part("text/html", toHtml(input.body)),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

export interface SendResult {
  providerMessageId: string;
  providerThreadId: string;
  /** Gmail's Message-ID for what went out, or null if it could not be read. */
  rfc822MessageId: string | null;
}

export async function sendMessage(input: {
  accessToken: string;
  message: MessageInput;
  /** Gmail's own thread id, when continuing a conversation we started. */
  threadId?: string | null;
}): Promise<SendResult> {
  const raw = Buffer.from(buildMimeMessage(input.message), "utf8").toString(
    "base64url",
  );

  const response = await fetch(SEND_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(
      input.threadId ? { raw, threadId: input.threadId } : { raw },
    ),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new GmailSendError(
      `gmail send failed (${response.status}): ${detail.slice(0, 500)}`,
      response.status,
    );
  }

  const payload = (await response.json()) as { id?: string; threadId?: string };
  if (!payload.id) {
    // Without an id we cannot prove which message went out, and the sent event
    // uses it as its dedupe token. Treat it as a failure rather than logging a
    // send we cannot identify.
    throw new GmailSendError("gmail returned no message id", response.status);
  }

  // Gmail swaps our Message-ID for one of its own (`…@mail.gmail.com`), and
  // until Sep 2026 this returned ours anyway: every follow-up's In-Reply-To
  // named a message the prospect never received, which Gmail threads past on
  // threadId and Outlook or Apple Mail do not. So read back what went out. The
  // email has left by now, so nothing here may throw: an id we could not read
  // is null, never the one we know is wrong.
  let rfc822MessageId: string | null = null;
  try {
    const sent = await fetchMessageMetadata(input.accessToken, payload.id, ["Message-ID"]);
    rfc822MessageId = sent.headers["message-id"]?.trim() || null;
  } catch {
    rfc822MessageId = null;
  }

  return {
    providerMessageId: payload.id,
    providerThreadId: payload.threadId ?? "",
    rfc822MessageId,
  };
}
