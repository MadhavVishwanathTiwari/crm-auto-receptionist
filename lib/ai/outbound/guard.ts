// What a first touch written by the assistant must be before it is anybody's
// draft, let alone an email.
//
// Stricter than the reply guard and stricter than /write, on purpose. A person
// writing to one business can see things a regex cannot, which is why the
// copy linter binds templates and not hand-written email. The assistant is
// closer to a template than to a person: in send mode nobody reads it first.
// So it is held to the template rules, plus the reply guard's rules about
// what may appear in a body at all.
//
// Pure, so every rule is a unit test.

import { linkedUrls } from "@/lib/gmail/body";
import { lintTemplate } from "@/lib/templates/lint";

const LEFTOVER_VARIABLE = /\{\{\s*[a-z_]+\s*\}\}/i;
const EMAIL_SHAPED = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const PHONE_SHAPED = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/;

/** A first touch to a stranger. Past this it is a pitch deck. */
export const MAX_BODY_CHARS = 1000;
const MAX_SUBJECT_CHARS = 80;

export type FirstTouchCheck = { ok: true } | { ok: false; problems: string[] };

export function checkFirstTouch(
  subject: string,
  body: string,
  limits: { senderName: string },
): FirstTouchCheck {
  const problems: string[] = [];
  const s = subject.trim();
  const b = body.trim();

  if (s.length > MAX_SUBJECT_CHARS) {
    problems.push(`The subject is ${s.length} characters; keep it under ${MAX_SUBJECT_CHARS}.`);
  }
  if (/^(re|fwd?):/i.test(s)) {
    problems.push("A first touch subject must not pretend to be a reply or a forward.");
  }
  if (b.length > MAX_BODY_CHARS) {
    problems.push(`The body is ${b.length} characters; keep it under ${MAX_BODY_CHARS}.`);
  }

  // The house rules, word for word as a template is held to them.
  for (const violation of lintTemplate(s, b)) problems.push(violation.message);

  if (LEFTOVER_VARIABLE.test(s) || LEFTOVER_VARIABLE.test(b)) {
    problems.push("It contains a {{variable}}. A written email goes out exactly as typed.");
  }

  // No link of any kind in a cold first touch: there is nothing to link to yet
  // (the demo is T2's job) and a link in a first email from a stranger is what
  // spam filters are best at noticing.
  if (linkedUrls(b).length > 0 || /\bwww\.|https?:\/\//i.test(s + b)) {
    problems.push("It contains a link or web address. A first touch carries none.");
  }

  // Anything it could have copied off the site: theirs or somebody else's.
  if (EMAIL_SHAPED.test(s + "\n" + b)) {
    problems.push("It contains an email address.");
  }
  if (PHONE_SHAPED.test(b)) {
    problems.push("It contains a phone number.");
  }

  // Signed as the person whose mailbox it leaves from, which is what was asked
  // for: the assistant writes as them, not as itself.
  const lastLine = b.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  if (!lastLine.toLowerCase().includes(limits.senderName.trim().toLowerCase())) {
    problems.push(`It must end with the sign-off "${limits.senderName}" on its own line.`);
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}
