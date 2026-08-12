// Suppression reasons live here, NOT in actions.ts, on purpose.
//
// actions.ts carries "use server", and a server-action module may only export
// async functions. A plain value like this array survives typecheck, lint and
// the build when exported from there, but a CLIENT component that imports it
// receives a server-reference proxy rather than the array — so `.map` throws at
// hydration and the component crashes. Both SuppressionList and the lead drawer
// import these, so both broke. A plain module has no such restriction.

export type SuppressionReason =
  | "unsubscribed"
  | "bounced_hard"
  | "complaint"
  | "manual_dnc"
  | "competitor"
  | "customer";

export const SUPPRESSION_REASONS: Array<{ value: SuppressionReason; label: string }> = [
  { value: "manual_dnc", label: "Asked not to be contacted" },
  { value: "unsubscribed", label: "Unsubscribed" },
  { value: "bounced_hard", label: "Hard bounce" },
  { value: "complaint", label: "Spam complaint" },
  { value: "competitor", label: "Competitor" },
  { value: "customer", label: "Already a customer" },
];
