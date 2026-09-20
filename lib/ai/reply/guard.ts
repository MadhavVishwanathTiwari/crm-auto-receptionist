// The check that actually binds.
//
// The system prompt asks the model for these properties; this decides whether
// it got them. That split is the whole design: a rule stated only in a prompt
// is a preference, and the thing on the other end of this is a real email to a
// real business, signed with somebody's name.
//
// Same bargain /write makes with a hand-written email (app/(app)/write/
// actions.ts): the composer checks as you type and the action checks again,
// because the composer is a browser and a browser can be wrong. Here the model
// is the browser.
//
// Pure, so every rule below is a unit test with no network.

import { brokenLinks, linkedUrls } from "@/lib/gmail/body";

/** A composed body is dispatched verbatim, so a leftover variable ships. */
const LEFTOVER_VARIABLE = /\{\{\s*[a-z_]+\s*\}\}/i;

/**
 * An email address anywhere in the body.
 *
 * Not a validator -- deliberately loose, because this is looking for something
 * that should not be there at all rather than checking one that should.
 */
const EMAIL_SHAPED = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** A reply to one person. Anything longer is a brochure. */
const MAX_CHARS = 1500;

export interface DraftLimits {
  bookingUrl: string;
  /** This lead's demo, when one exists. */
  demoUrl: string | null;
  /** The address it is going out from, which may legitimately appear. */
  mailboxEmail: string;
}

export type DraftCheck = { ok: true } | { ok: false; reason: string };

/** Trailing punctuation a model puts after a URL in a sentence. */
function trimUrl(url: string): string {
  return url.replace(/[).,;:!?]+$/, "").replace(/\/+$/, "").toLowerCase();
}

export function checkDraft(body: string, limits: DraftLimits): DraftCheck {
  const text = body.trim();

  if (!text) {
    return { ok: false, reason: "the model returned an empty body" };
  }

  if (text.length > MAX_CHARS) {
    return {
      ok: false,
      reason: `the body is ${text.length} characters, over the ${MAX_CHARS} limit`,
    };
  }

  const leftover = text.match(LEFTOVER_VARIABLE);
  if (leftover) {
    return {
      ok: false,
      reason: `the body still contains ${leftover[0]}, which would go out with the braces showing`,
    };
  }

  const broken = brokenLinks(text);
  if (broken.length > 0) {
    return {
      ok: false,
      reason: `${broken[0]} would not become a link. The address has to start with https://`,
    };
  }

  // The important one. A model that invents a pricing page, a docs link or a
  // competitor's address gets caught here and nowhere else, and linkedUrls()
  // reads BOTH shapes -- the bracket form and a bare URL sitting in the prose,
  // which toHtml() anchors just the same.
  const allowed = new Set(
    [limits.bookingUrl, limits.demoUrl]
      .filter((url): url is string => Boolean(url))
      .map(trimUrl),
  );

  for (const url of linkedUrls(text)) {
    if (!allowed.has(trimUrl(url))) {
      return {
        ok: false,
        reason: `the body links to ${url}, which is not the booking link or this lead's demo`,
      };
    }
  }

  // An address we did not put there is either invented or somebody else's.
  // The sending mailbox is the one exception: signing off with it is fine.
  const mailbox = limits.mailboxEmail.trim().toLowerCase();
  for (const address of text.match(EMAIL_SHAPED) ?? []) {
    if (address.toLowerCase() !== mailbox) {
      return {
        ok: false,
        reason: `the body names the email address ${address}, which is not the sending mailbox`,
      };
    }
  }

  return { ok: true };
}
