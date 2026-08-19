// Which account belongs to which human.
//
// The consumer of dashboard_activity()'s `operators` roster, in the same
// relationship buildMailboxSenders() has with public.mailbox_senders(): the
// resolution already happened in SQL against app.operator_aliases, and this
// file turns the answer into a lookup without ever learning what an alias is.
//
// That separation is 0032's rule and it is not stylistic. app.operator_aliases
// is revoked from `authenticated` so it has no API path at all, so a TypeScript
// copy of "are these two accounts the same person" could not read the same data
// even if somebody wrote one -- it would have to guess, and it would drift.

export interface OperatorGroup {
  /** The stable name: 'madhav', 'ojas', or an address with no alias row. */
  operator: string;
  user_ids: string[];
  emails: string[];
}

/** userId -> operator. One entry per account, including an operator's second. */
export function operatorIndex(groups: OperatorGroup[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const group of groups) {
    for (const userId of group.user_ids ?? []) {
      if (userId) index.set(userId, group.operator);
    }
  }
  return index;
}

/**
 * The operator this lead's owner is, or null for the unclaimed pool.
 *
 * Null rather than a bucket called "unknown", because an unclaimed lead is not
 * somebody's poor performance -- it is work nobody has picked up, and the
 * dashboard counts it separately for that reason.
 */
export function operatorFor(
  userId: string | null,
  index: Map<string, string>,
): string | null {
  if (!userId) return null;
  return index.get(userId) ?? null;
}

/** Display order: alphabetical, so the same operator is in the same place. */
export function operatorNames(groups: OperatorGroup[]): string[] {
  return groups.map((group) => group.operator).sort((a, b) => a.localeCompare(b));
}
