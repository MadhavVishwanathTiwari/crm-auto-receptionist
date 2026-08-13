// Shared vectors for the copy linter, driven through BOTH implementations.
//
// tests/unit/templateLint.test.ts runs them through lib/templates/lint.ts.
// tests/integration/template-lint-parity.test.ts runs the same ones through
// app.template_lint() by way of the trigger that actually blocks activation,
// and asserts the two agree rule for rule. Two implementations of the same
// rules is a latent bug unless something makes keeping them identical
// non-negotiable; this is that something.

export interface TemplateVector {
  label: string;
  subject: string;
  body: string;
  /** Rule codes, in the order both implementations emit them. */
  expected: string[];
}

/** The reference: clean copy that is allowed to go live. */
export const CLEAN_BODY = [
  "Hi {{first_name}},",
  "",
  "I texted {{company_name}} at {{audit_time_local}} on {{audit_day_local}} and {{response_delay}}.",
  "Every one of those is a booking you are losing to whoever picks up first.",
  "",
  "Worth a look this week, or should I close the file?",
].join("\n");

export const CLEAN_SUBJECT = "Your {{audit_day_local}} text went unanswered";

export const TEMPLATE_VECTORS: TemplateVector[] = [
  {
    label: "clean",
    subject: CLEAN_SUBJECT,
    body: CLEAN_BODY,
    expected: [],
  },
  {
    label: "em dash in the body",
    subject: CLEAN_SUBJECT,
    body: CLEAN_BODY.replace(
      "Every one of those is",
      "Every one of those — every single one — is",
    ),
    expected: ["em_dash"],
  },
  {
    label: "en dash counts too",
    subject: "Your text – unanswered",
    body: CLEAN_BODY,
    expected: ["em_dash"],
  },
  {
    label: "no loss framing",
    subject: CLEAN_SUBJECT,
    body: [
      "Hi {{first_name}},",
      "",
      "We build an AI receptionist for {{company_name}}. It answers calls and texts.",
      "",
      "Happy to show you, or shall I send a link?",
    ].join("\n"),
    expected: ["loss_frame"],
  },
  {
    label: "open-ended close",
    subject: CLEAN_SUBJECT,
    body: CLEAN_BODY.replace(
      "Worth a look this week, or should I close the file?",
      "What do you think?",
    ),
    expected: ["binary_close"],
  },
  {
    label: "two asks",
    subject: CLEAN_SUBJECT,
    body: CLEAN_BODY.replace(
      "Worth a look this week, or should I close the file?",
      "Does that sound familiar? Worth a look this week, or should I close the file?",
    ),
    expected: ["one_ask"],
  },
  {
    label: "no ask at all",
    subject: CLEAN_SUBJECT,
    body: CLEAN_BODY.replace(
      "Worth a look this week, or should I close the file?",
      "Let me know either way.",
    ),
    expected: ["binary_close", "one_ask"],
  },
  {
    label: "unknown variable",
    subject: CLEAN_SUBJECT,
    body: CLEAN_BODY.replace("{{first_name}}", "{{firstname}}"),
    expected: ["unknown_variable"],
  },
  {
    label: "empty subject",
    subject: "   ",
    body: CLEAN_BODY,
    expected: ["empty_subject"],
  },
  {
    label: "empty body short-circuits the rest",
    subject: CLEAN_SUBJECT,
    body: "",
    expected: ["empty_body"],
  },
  {
    label: "several at once, in order",
    subject: "Quick question —",
    body: [
      "Hi {{firstname}},",
      "",
      "We do AI receptionists. Interested? Want a demo?",
    ].join("\n"),
    expected: ["em_dash", "loss_frame", "binary_close", "one_ask", "unknown_variable"],
  },
];
