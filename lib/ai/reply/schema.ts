import { z } from "zod";

// What the model is allowed to answer with.
//
// `action` and `body` are separate on purpose. A single "write the reply or an
// empty string" field makes "I decided not to answer" and "I failed to write
// anything" the same value, and those need different handling: one is a
// skipped row, the other is a failure that raises an alert.
//
// `reason` is required on both branches, because the majority of rows will be
// skips and a skip with no reason is a row nobody can learn anything from.

export const ReplyIntents = [
  "interested",
  "question",
  "negative",
  "automated",
  "wrong_person",
  "unclear",
  "other",
] as const;

export const ReplyDecisionSchema = z.object({
  action: z.enum(["reply", "skip"]),
  intent: z.enum(ReplyIntents),
  /** One sentence, in the operator's words, for the row and the alert. */
  reason: z.string().min(1).max(400),
  /** The email itself. Null when action is "skip". */
  body: z.string().max(4000).nullable(),
  /** The model punted: the reply says a person will follow up. */
  needs_human: z.boolean(),
});

export type ReplyDecision = z.infer<typeof ReplyDecisionSchema>;
