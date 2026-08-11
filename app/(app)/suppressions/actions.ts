"use server";

import { revalidatePath } from "next/cache";

import { normalizeDomain, normalizeEmail, normalizePhone } from "@/lib/normalize";
import { getOrgContext } from "@/lib/org";

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

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export interface SuppressionInput {
  email?: string | null;
  domain?: string | null;
  phone?: string | null;
  reason: SuppressionReason;
  notes?: string | null;
  leadId?: string | null;
}

/**
 * Adds a do-not-contact entry.
 *
 * The normalization here is load-bearing and easy to miss: unlike `leads`,
 * whose work_email_norm / website_domain / phone_e164 are GENERATED columns
 * computed by Postgres, the matching columns on `suppressions` are plain text.
 * Nothing normalizes them for us. An entry stored as "Owner@Acme.com " never
 * matches the lead it was meant to stop, and the failure is silent — the lead
 * simply gets emailed.
 *
 * tests/integration/normalize-parity.test.ts pins these TypeScript functions
 * against their SQL counterparts, which is what makes using them here safe.
 */
export async function addSuppression(input: SuppressionInput): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };
  const { supabase, orgId, userId } = context;

  const email_norm = normalizeEmail(input.email ?? null);
  const domain = normalizeDomain(input.domain ?? null);
  const phone_e164 = normalizePhone(input.phone ?? null);

  // Mirrors the suppressions_has_target check, so an empty form is a readable
  // message rather than a constraint violation.
  if (!email_norm && !domain && !phone_e164) {
    return {
      ok: false,
      error: "Give an email address, a domain or a phone number to suppress.",
    };
  }

  const { data, error } = await supabase
    .from("suppressions")
    .insert({
      org_id: orgId,
      email_norm,
      domain,
      phone_e164,
      reason: input.reason,
      notes: input.notes?.trim() || null,
      lead_id: input.leadId ?? null,
      created_by: userId,
    })
    .select("id");

  if (error) {
    // Partial unique indexes on (org_id, email_norm) and (org_id, domain).
    // Suppressing something twice is a no-op, not a fault.
    if (error.code === "23505") {
      return { ok: false, error: "That is already on the do-not-contact list." };
    }
    return { ok: false, error: error.message };
  }
  if (!data || data.length === 0) {
    return { ok: false, error: "That suppression was refused." };
  }

  revalidatePath("/suppressions");
  revalidatePath("/queue");
  return { ok: true };
}

/**
 * Suppresses the lead's own address or its whole domain.
 *
 * Domain scope exists because one "take us off your list" reply should cover
 * every contact at that company, not just the person who happened to answer.
 */
export async function suppressLead(
  leadId: string,
  scope: "email" | "domain",
  reason: SuppressionReason,
  notes: string,
): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };

  const { data: lead, error: leadError } = await context.supabase
    .from("leads")
    .select("id, work_email, website")
    .eq("id", leadId)
    .maybeSingle();

  if (leadError) return { ok: false, error: leadError.message };
  if (!lead) return { ok: false, error: "That lead is no longer there." };

  if (scope === "email" && !lead.work_email) {
    return { ok: false, error: "That lead has no work email to suppress." };
  }
  if (scope === "domain" && !lead.website) {
    return { ok: false, error: "That lead has no website to take a domain from." };
  }

  return addSuppression({
    email: scope === "email" ? lead.work_email : null,
    domain: scope === "domain" ? lead.website : null,
    reason,
    notes,
    leadId,
  });
}

/**
 * Removes an entry. Admin-only at the policy level, because taking someone OFF
 * the do-not-contact list is the dangerous direction.
 */
export async function removeSuppression(id: string): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };

  const { data, error } = await context.supabase
    .from("suppressions")
    .delete()
    .eq("id", id)
    .select("id");

  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: "Only an admin can remove a suppression." };
  }

  revalidatePath("/suppressions");
  revalidatePath("/queue");
  return { ok: true };
}
