// The copy linter.
//
// Four constraints out of the brief, plus one structural check:
//
//   no em dashes        they read as machine-written, and every ESP that scores
//                       copy treats a run of them as a tell
//   loss-framed CTA     "you are losing the call" outperforms "we can help"
//   binary-choice close  a question with two answers gets replied to; an
//                       open-ended one gets ignored
//   one ask per email    two questions is zero questions
//   known variables      a body containing {{firstname}} renders that string
//                       verbatim into a live email
//
// This file is mirrored by app.template_lint() in
// supabase/migrations/0014_templates.sql, and a template cannot be set
// is_active unless the SQL side agrees it is clean. The database is the
// enforcement; this exists so the editor can say so before you hit save.
// tests/integration/template-lint-parity.test.ts runs the same vectors through
// both and asserts they return the same rule codes, which is the only thing
// keeping two implementations honest — the same arrangement lib/normalize uses.

export type LintRule =
  | "empty_subject"
  | "empty_body"
  | "em_dash"
  | "loss_frame"
  | "binary_close"
  | "one_ask"
  | "unknown_variable";

export interface LintViolation {
  rule: LintRule;
  message: string;
}

/**
 * Variables a body may interpolate. Anything else is a typo, and a typo here
 * ships as literal braces to a prospect.
 *
 * Kept in sync with renderTemplate() in ./render.ts, which is what actually
 * substitutes them, and with the same list in the SQL mirror.
 */
export const TEMPLATE_VARIABLES = [
  "first_name",
  "last_name",
  "company_name",
  "city",
  "state",
  "industry",
  // Frozen at audit time, not recomputed — see lead_evidence in 0003.
  "audit_time_local",
  "audit_day_local",
  "audit_outcome",
  "response_delay",
  "demo_url",
  "sender_name",
] as const;

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

// U+2014 EM DASH and U+2013 EN DASH. Both, because an en dash used as a clause
// break reads exactly the same way and is the obvious workaround.
const EM_DASH = /[—–]/;

// Loss framing. A vocabulary rather than a sentiment model on purpose: this has
// to be checkable in one line of SQL, and a false negative costs an operator
// one rewrite while a false positive would let bland copy through.
const LOSS_FRAME =
  /\b(miss|misses|missed|missing|lose|loses|losing|lost|slip|slips|slipping|unanswered|ignored|leak|leaks|leaking|costing|walks away|walk away|walking away|never hears back|never hear back|straight to voicemail|goes to voicemail|no one answers|nobody answers|going elsewhere|somewhere else|someone else)\b/i;

// A question whose sentence also contains "or": the binary close. Bounded by
// sentence punctuation so an "or" three sentences earlier does not satisfy it.
const BINARY_CLOSE = /[^.!?]*\bor\b[^.!?]*\?/i;

const VARIABLE = /\{\{\s*([a-z_]+)\s*\}\}/gi;

const MESSAGES: Record<LintRule, string> = {
  empty_subject: "The subject line is empty.",
  empty_body: "The body is empty.",
  em_dash:
    "Contains an em or en dash. Use a comma, a full stop or a colon instead.",
  loss_frame:
    "No loss framing. Say what the prospect is losing right now, not what we offer.",
  binary_close:
    "No binary-choice close. End on a question that offers two answers, joined by “or”.",
  one_ask:
    "More than one question, or none. Exactly one ask per email, and it is the close.",
  unknown_variable: "Uses a variable that does not exist.",
};

/** Every `{{name}}` in the text, in order, lowercased. */
export function templateVariables(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(VARIABLE)) {
    found.push(match[1]!.toLowerCase());
  }
  return found;
}

/**
 * Returns the rule codes a template violates, in a fixed order. An empty array
 * means it is clean and may be activated.
 */
export function lintTemplateRules(subject: string, body: string): LintRule[] {
  const rules: LintRule[] = [];
  const subjectText = subject ?? "";
  const bodyText = body ?? "";

  if (subjectText.trim() === "") rules.push("empty_subject");
  if (bodyText.trim() === "") rules.push("empty_body");

  // Everything below reads the body, and an empty one would fail all of them
  // at once. Reporting "the body is empty" five ways is not more helpful.
  if (bodyText.trim() === "") return rules;

  if (EM_DASH.test(subjectText) || EM_DASH.test(bodyText)) rules.push("em_dash");
  if (!LOSS_FRAME.test(bodyText)) rules.push("loss_frame");
  if (!BINARY_CLOSE.test(bodyText)) rules.push("binary_close");

  const asks = (bodyText.match(/\?/g) ?? []).length;
  if (asks !== 1) rules.push("one_ask");

  const known = new Set<string>(TEMPLATE_VARIABLES);
  const used = [
    ...templateVariables(subjectText),
    ...templateVariables(bodyText),
  ];
  if (used.some((name) => !known.has(name))) rules.push("unknown_variable");

  return rules;
}

/** The same result with a sentence attached to each code, for the editor. */
export function lintTemplate(subject: string, body: string): LintViolation[] {
  return lintTemplateRules(subject, body).map((rule) => ({
    rule,
    message: MESSAGES[rule],
  }));
}

export function lintsClean(subject: string, body: string): boolean {
  return lintTemplateRules(subject, body).length === 0;
}

/** Names used in the text that are not real variables. For the editor's hint. */
export function unknownVariables(subject: string, body: string): string[] {
  const known = new Set<string>(TEMPLATE_VARIABLES);
  const used = new Set([
    ...templateVariables(subject ?? ""),
    ...templateVariables(body ?? ""),
  ]);
  return [...used].filter((name) => !known.has(name));
}
