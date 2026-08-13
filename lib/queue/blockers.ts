// What is holding a lead back from its next touch.
//
// One definition, because two screens ask the question. The queue lists leads
// by blocker; settings counts how many are ready and calls that "you can send".
// A second copy of this rule would let the two disagree about whether the app
// is ready to run, which is the one thing neither screen is allowed to be wrong
// about.
//
// This is a READ-side summary, not the gate. The gate is the planner's WHERE
// clause plus app.scheduled_sends_require_timezone(); this exists so a human
// can see the same answer before the planner runs.

/** Statuses that mean the first touch has already gone out. */
export const IN_FLIGHT = new Set([
  "sent",
  "delivered",
  "opened",
  "replied",
  "bounced",
  "unsubscribed",
  "closed_won",
  "closed_lost",
  "do_not_contact",
]);

export type Blocker =
  | "ready"
  | "halted"
  | "suppressed"
  | "no_timezone"
  | "not_qualified"
  | "not_claimed"
  | "not_audited";

/** Most blocking first, which is also the order the queue lists them in. */
export const BLOCKER_ORDER: Blocker[] = [
  "ready",
  "not_audited",
  "not_claimed",
  "no_timezone",
  "not_qualified",
  "suppressed",
  "halted",
];

export interface BlockerLead {
  status: string;
  claimed_by: string | null;
  timezone: string | null;
  is_qualified: boolean;
  halted_at: string | null;
  terminal_outcome: string | null;
  work_email_norm: string | null;
  website_domain: string | null;
}

export interface SuppressionIndex {
  emails: Set<string>;
  domains: Set<string>;
}

export function suppressionIndex(
  rows: { email_norm: string | null; domain: string | null }[] | null,
): SuppressionIndex {
  return {
    emails: new Set(
      (rows ?? []).map((r) => r.email_norm).filter(Boolean) as string[],
    ),
    domains: new Set(
      (rows ?? []).map((r) => r.domain).filter(Boolean) as string[],
    ),
  };
}

/**
 * The single most blocking reason this lead is not sendable, or "ready".
 *
 * Ordered most severe first on purpose: a halted or suppressed lead must never
 * read as ready just because it also happens to be claimed and audited.
 */
export function classifyLead(
  lead: BlockerLead,
  suppressions: SuppressionIndex,
): Blocker {
  if (lead.halted_at || lead.terminal_outcome) return "halted";
  if (
    (lead.work_email_norm && suppressions.emails.has(lead.work_email_norm)) ||
    (lead.website_domain && suppressions.domains.has(lead.website_domain))
  ) {
    return "suppressed";
  }
  if (!lead.timezone) return "no_timezone";
  if (!lead.is_qualified) return "not_qualified";
  if (!lead.claimed_by) return "not_claimed";
  if (lead.status !== "audited" && lead.status !== "queued") return "not_audited";
  return "ready";
}
