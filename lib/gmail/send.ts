// Building an RFC 5322 message and handing it to Gmail.
//
// Plain text, one part, no HTML alternative and no tracking pixel. That is a
// deliverability decision rather than a simplification: a cold first touch that
// looks like a newsletter gets filed like one, and the reply rate is the only
// metric this pipeline has.

import { randomUUID } from "node:crypto";

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
  /** Our own Message-ID, so a later touch can thread onto this one. */
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

/**
 * The raw message.
 *
 * CRLF line endings throughout, and the body is base64 so a long line, a stray
 * bare newline or a leading "From " in the copy cannot corrupt the message.
 */
export function buildMimeMessage(input: MessageInput): string {
  const headers: string[] = [
    `From: ${formatAddress(input.from)}`,
    `To: ${formatAddress(input.to)}`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    `Message-ID: ${input.messageId}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];

  if (input.inReplyTo) {
    headers.push(`In-Reply-To: ${input.inReplyTo}`);
    // References carries the whole chain, oldest first. Gmail threads on it,
    // and so does every other client the prospect might be using.
    const chain = [...(input.references ?? []), input.inReplyTo];
    headers.push(`References: ${[...new Set(chain)].join(" ")}`);
  }

  const encoded = Buffer.from(input.body.replace(/\r?\n/g, "\r\n"), "utf8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n");

  return `${headers.join("\r\n")}\r\n\r\n${encoded}\r\n`;
}

export interface SendResult {
  providerMessageId: string;
  providerThreadId: string;
  rfc822MessageId: string;
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

  return {
    providerMessageId: payload.id,
    providerThreadId: payload.threadId ?? "",
    rfc822MessageId: input.message.messageId,
  };
}
