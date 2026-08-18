"use server";

import { revalidatePath } from "next/cache";

import { getOrgContext } from "@/lib/org";

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** How many leads the call actually took, for the bulk claim. */
  count?: number;
}

/**
 * Claiming goes through the RPCs and never through an UPDATE.
 *
 * `leads_guard_protected_columns` rejects a direct write to claimed_by, so this
 * is not a convention the UI is choosing to follow — a read-then-write would be
 * a race, and the database refuses to let one exist.
 */
export async function claimLead(leadId: string): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };

  const { error } = await context.supabase.rpc("claim_lead", { p_lead_id: leadId });

  if (error) {
    // 55006 is the RPC's "already claimed", which is an ordinary outcome when
    // two operators click the same row, not a fault to surface as a stack.
    return {
      ok: false,
      error:
        error.code === "55006"
          ? "Someone else claimed that lead first."
          : error.message,
    };
  }

  revalidatePath("/leads");
  return { ok: true };
}

/**
 * Sends this lead without auditing it first.
 *
 * The pipeline's default is that a first touch quotes an audit back, because
 * that is what makes the copy worth reading. It is also what makes a first
 * touch expensive: somebody has to text the business and time the reply. On a
 * thousand scraped rows most leads are not worth that, and the choice is
 * between generic copy and no copy at all.
 *
 * So this is per lead and explicit, rather than a setting. The operator is
 * asserting "this one is not worth an audit", which is a judgement about that
 * business and nothing else in the system can make it.
 *
 * Mechanically it inserts a `queued` event. Status is derived, never typed, so
 * there is no UPDATE here to be refused by leads_guard_protected_columns: the
 * event ranks above `audited` in app.lead_status_from_events, the trigger
 * recomputes leads.status, and the planner has accepted `queued` since 0015.
 * The lead keeps angle_type null, which is what selects the generic template.
 *
 * Through an RPC since 0036, and it had to be. This inserted the event directly
 * for four migrations, but lead_events_insert permits only ('audited', 'note',
 * 'manual_override'), so every insert was rejected and the button never worked
 * for anybody.
 *
 * The old code guarded for the wrong failure: a `with check` violation on
 * INSERT raises 42501, it is not the silent 204-with-zero-rows case. That case
 * is UPDATE and DELETE, where a `using` clause filters the row out before there
 * is anything to violate — which is why setLeadTimezone below genuinely needs
 * its zero-row check and this never did. Operators saw Postgres's own message.
 *
 * Widening the policy was the wrong fix: it checks org_id and nothing else, so
 * it would have let either operator queue the other's leads. The ownership
 * check lives in the definer function instead.
 */
export async function queueWithoutAudit(leadId: string): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };

  const { error } = await context.supabase.rpc("queue_lead_without_audit", {
    p_lead_id: leadId,
  });

  if (error) {
    return {
      ok: false,
      error:
        error.code === "42501" ? "That lead is not yours to queue." : error.message,
    };
  }

  revalidatePath("/leads");
  revalidatePath("/queue");
  revalidatePath("/settings");
  return { ok: true };
}

export async function releaseLead(leadId: string): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };

  const { error } = await context.supabase.rpc("release_lead", { p_lead_id: leadId });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/leads");
  return { ok: true };
}

/**
 * Bulk claim off the shared pool. The RPC uses SKIP LOCKED, so two operators
 * pressing this at the same moment take disjoint sets rather than one waiting.
 */
export async function claimFromPool(limit: number): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };

  const { data, error } = await context.supabase.rpc("claim_leads_from_pool", {
    p_limit: limit,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/leads");
  return { ok: true, count: Array.isArray(data) ? data.length : 0 };
}

/** Rejects anything the runtime does not recognise as an IANA zone. */
function isValidTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Assigns or clears a lead's timezone.
 *
 * A plain UPDATE: the guard trigger stamps `timezone_source` for us, 'manual'
 * on assignment and null on a clear, so an automated resolution pass cannot
 * later overwrite a human correction. Writing the source here would fight it.
 *
 * Clearing only became possible in migration 0010 — before that the guard set
 * 'manual' unconditionally, which violated the constraint tying a zone and its
 * source together.
 */
export async function setLeadTimezone(
  leadId: string,
  timezone: string | null,
): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };

  const zone = timezone?.trim() || null;
  if (zone !== null && !isValidTimezone(zone)) {
    return { ok: false, error: `"${zone}" is not an IANA timezone name.` };
  }

  const { data, error } = await context.supabase
    .from("leads")
    .update({ timezone: zone })
    .eq("id", leadId)
    .select("id, timezone, timezone_source");

  if (error) return { ok: false, error: error.message };
  // A write refused by RLS is 204 with zero rows and no error. The update
  // policy rejects a lead claimed by the other operator.
  if (!data || data.length === 0) {
    return {
      ok: false,
      error: "That change was refused. The lead is probably claimed by someone else.",
    };
  }

  revalidatePath("/leads");
  revalidatePath("/queue");
  revalidatePath("/audit");
  return { ok: true };
}

export type TerminalOutcome = "closed_won" | "closed_lost" | "do_not_contact";

/**
 * Records a terminal outcome.
 *
 * The one path by which a human sets status directly, and even it goes through
 * the event log: close_lead() writes terminal_outcome under the guard bypass
 * and then inserts a `closed` event, so the timeline stays complete.
 *
 * There is no inverse. A terminal outcome beats every later event in
 * app.lead_status_from_events, and the guard blocks clearing the column, so
 * reopening a lead would need a new RPC. The UI confirms before calling this.
 */
export async function closeLead(
  leadId: string,
  outcome: TerminalOutcome,
  note: string,
): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };

  const { error } = await context.supabase.rpc("close_lead", {
    p_lead_id: leadId,
    p_outcome: outcome,
    p_note: note.trim() || null,
  });

  if (error) {
    return {
      ok: false,
      error:
        error.code === "42501"
          ? "That lead belongs to someone else."
          : error.message,
    };
  }

  revalidatePath("/leads");
  revalidatePath("/queue");
  revalidatePath("/audit");
  return { ok: true };
}
