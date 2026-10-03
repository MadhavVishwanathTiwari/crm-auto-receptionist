import { z } from "zod";

// What the model may answer with when it is asked to write a first touch.
//
// `skip` is a real answer, not a failure. The pool holds a labor union, a
// basketball court and a government office alongside the plumbers, and the
// right email to a business that never takes a call from a customer is none.

export const OutboundDecisionSchema = z.object({
  action: z.enum(["write", "skip"]),
  /**
   * One sentence for the operator: what it saw on the site that it built the
   * email on, or why it passed.
   */
  reason: z.string().min(1).max(400),
  /** Null when action is "skip". */
  subject: z.string().max(200).nullable(),
  /** Null when action is "skip". */
  body: z.string().max(4000).nullable(),
});

export type OutboundDecision = z.infer<typeof OutboundDecisionSchema>;
