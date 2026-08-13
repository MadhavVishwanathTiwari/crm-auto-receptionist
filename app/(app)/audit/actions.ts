"use server";

import { DateTime } from "luxon";
import { revalidatePath } from "next/cache";

import { getOrgContext } from "@/lib/org";

export type AngleType = "soft_text_audit" | "voicemail_drop_audit";

export interface AuditInput {
  leadId: string;
  angleType: AngleType;
  /** When the audit was performed. ISO instant; defaults to now. */
  auditedAt?: string;
  /** Seconds until the business responded. Null means they never did. */
  responseDelaySeconds: number | null;
  outcome: string;
  notes: string;
  /**
   * Object path in the private `lead-evidence` bucket, uploaded by the browser
   * before this runs. Not a URL — the bucket is private, so viewing it later
   * needs a signed URL.
   */
  screenshotPath?: string | null;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/**
 * Records an audit and advances the lead to `audited`.
 *
 * Two writes, in this order, and both matter:
 *
 *   1. lead_evidence — the artifact the first touch quotes back.
 *   2. lead_events('audited') — which is what actually moves the status, via
 *      the trigger. Nothing writes leads.status directly; the guard rejects it.
 *
 * The evidence goes first because it is the thing with real content. If the
 * event insert then fails, the lead stays un-audited with an orphan evidence
 * row, which an operator can see and retry. The reverse order would leave a
 * lead marked audited with no evidence behind it, and the email would have
 * nothing to quote.
 */
export async function recordAudit(input: AuditInput): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };
  const { supabase, orgId, userId } = context;

  const outcome = input.outcome.trim();
  if (!outcome) {
    return { ok: false, error: "Say what happened, even if it was nothing." };
  }
  if (
    input.responseDelaySeconds !== null &&
    (!Number.isFinite(input.responseDelaySeconds) || input.responseDelaySeconds < 0)
  ) {
    return { ok: false, error: "Response time cannot be negative." };
  }

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("id, timezone, claimed_by, company_name")
    .eq("id", input.leadId)
    .maybeSingle();

  if (leadError) return { ok: false, error: leadError.message };
  if (!lead) return { ok: false, error: "That lead is no longer there." };

  // An unresolved zone is never scheduled, and the copy quotes a local
  // wall-clock time back at the prospect. Auditing without one would produce
  // evidence that cannot be used in an email.
  if (!lead.timezone) {
    return {
      ok: false,
      error: "This lead has no timezone yet, so the audit time cannot be pinned.",
    };
  }
  if (lead.claimed_by !== userId) {
    return { ok: false, error: "Claim the lead before auditing it." };
  }

  const auditedAt = input.auditedAt
    ? DateTime.fromISO(input.auditedAt)
    : DateTime.now();
  if (!auditedAt.isValid) {
    return { ok: false, error: "That audit time is not a real date." };
  }

  // All three are stored deliberately. The wall-clock reading is FROZEN here
  // rather than recomputed later from leads.timezone, because an operator may
  // correct that zone after the fact and the email has already claimed "I
  // texted your business at 3am".
  const local = auditedAt.setZone(lead.timezone);
  const auditTimezone = lead.timezone as string;

  const { data: evidence, error: evidenceError } = await supabase
    .from("lead_evidence")
    .insert({
      org_id: orgId,
      lead_id: lead.id,
      angle_type: input.angleType,
      audited_at: auditedAt.toUTC().toISO(),
      // A `timestamp` column, so no offset: this is a wall-clock reading.
      audited_at_local: local.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      audit_timezone: auditTimezone,
      response_delay_seconds: input.responseDelaySeconds,
      outcome,
      notes: input.notes.trim() || null,
      screenshot_path: input.screenshotPath ?? null,
      created_by: userId,
    })
    .select("id");

  if (evidenceError) return { ok: false, error: evidenceError.message };
  // A write refused by RLS is 204 and zero rows, not an error.
  if (!evidence || evidence.length === 0) {
    return {
      ok: false,
      error: "That audit was refused. The lead is probably claimed by someone else.",
    };
  }

  const { data: event, error: eventError } = await supabase
    .from("lead_events")
    .insert({
      org_id: orgId,
      lead_id: lead.id,
      type: "audited",
      actor_id: userId,
      occurred_at: auditedAt.toUTC().toISO(),
      payload: {
        angle_type: input.angleType,
        outcome,
        response_delay_seconds: input.responseDelaySeconds,
        audited_at_local: local.toFormat("yyyy-MM-dd HH:mm"),
        audit_timezone: auditTimezone,
        evidence_id: evidence[0]?.id ?? null,
      },
    })
    .select("id");

  if (eventError) return { ok: false, error: eventError.message };
  if (!event || event.length === 0) {
    return {
      ok: false,
      error:
        "The audit was saved but the lead did not advance. Try recording it again.",
    };
  }

  // Stamp the angle on the LEAD, not just on the evidence.
  //
  // This is what picks the audit-quoting template over the generic one in
  // templateFor(): a lead carrying 'soft_text_audit' matches the template
  // pinned to that angle, and a lead with no angle falls back to the copy that
  // quotes nothing. Without this write, auditing a lead would change its status
  // but still send it the generic email, which is the one outcome nobody wants
  // after doing the work.
  //
  // Last, and deliberately not fatal. The audit and its event are already
  // committed; a failure here means the lead gets generic copy, which is worse
  // than the audit copy but far better than reporting a saved audit as failed
  // and having it recorded twice.
  const { error: angleError } = await supabase
    .from("leads")
    .update({ angle_type: input.angleType })
    .eq("id", lead.id)
    .select("id");

  if (angleError) {
    console.error(`could not stamp angle_type on lead ${lead.id}: ${angleError.message}`);
  }

  revalidatePath("/audit");
  revalidatePath("/leads");
  revalidatePath("/queue");
  return { ok: true };
}
