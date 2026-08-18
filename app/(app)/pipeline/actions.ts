"use server";

import { revalidatePath } from "next/cache";

import { getOrgContext } from "@/lib/org";
import type { PipelineStage } from "@/lib/pipeline/stages";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/** Every screen that can move a lead revalidates all three. */
function revalidateBoard() {
  revalidatePath("/pipeline");
  revalidatePath("/leads");
  revalidatePath("/queue");
}

/**
 * Moves a lead to a stage.
 *
 * Through the RPC, not an UPDATE: leads.stage is derived from stage_changed
 * events and the guard rejects a direct write, in the same way and for the same
 * reason claiming does.
 */
export async function setStage(
  leadId: string,
  stage: PipelineStage,
  note?: string,
): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };

  const { error } = await context.supabase.rpc("set_lead_stage", {
    p_lead_id: leadId,
    p_stage: stage,
    p_note: note?.trim() || null,
  });

  // The RPC's messages are written for an operator to read, so they are passed
  // through rather than replaced with something vaguer.
  if (error) return { ok: false, error: error.message };

  revalidateBoard();
  return { ok: true };
}

/**
 * Sets or clears the one thing to do next.
 *
 * A plain UPDATE. next_action and next_action_at are not guarded columns —
 * they are the operator's own notes to themselves, not derived state.
 *
 * `at` is an instant, already resolved by the browser from what the operator
 * typed. That looks like a violation of "all scheduling math is prospect-local"
 * and is not: this is a reminder for the person, in the person's own day. The
 * prospect-local rule governs when an email leaves, which is bookSlot's job.
 */
export async function setNextAction(
  leadId: string,
  action: string,
  at: string | null,
): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };

  const text = action.trim();
  if (at !== null && Number.isNaN(Date.parse(at))) {
    return { ok: false, error: "That is not a date I can read." };
  }
  // A date with nothing to do on it is a reminder with no content, and an
  // action with no date never surfaces as overdue. Refuse the half-filled form
  // rather than storing something that can never be acted on.
  if (text === "" && at !== null) {
    return { ok: false, error: "Say what the next action is, or clear the date too." };
  }

  const { data, error } = await context.supabase
    .from("leads")
    .update({ next_action: text || null, next_action_at: text ? at : null })
    .eq("id", leadId)
    .select("id");

  if (error) return { ok: false, error: error.message };
  // A write refused by RLS is 204 with zero rows and no error, so an empty
  // result is the denial rather than a miss.
  if (!data || data.length === 0) {
    return {
      ok: false,
      error: "That change was refused. The lead is probably claimed by someone else.",
    };
  }

  revalidateBoard();
  return { ok: true };
}

/** Overrides the org default for one deal. Null puts it back on the default. */
export async function setDealValue(
  leadId: string,
  value: number | null,
): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };

  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    return { ok: false, error: "A deal value has to be a positive number." };
  }

  const { data, error } = await context.supabase
    .from("leads")
    .update({ deal_value: value })
    .eq("id", leadId)
    .select("id");

  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return {
      ok: false,
      error: "That change was refused. The lead is probably claimed by someone else.",
    };
  }

  revalidateBoard();
  return { ok: true };
}

/**
 * Adds a note to the timeline.
 *
 * `note` has been in the lead_event_type enum since 0001 and permitted to
 * authenticated users by lead_events_insert since 0005. Nothing has ever
 * written one. It ranks 0 in app.lead_status_from_events, so a note cannot move
 * status, which is exactly what you want from commentary.
 */
export async function addNote(leadId: string, body: string): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };

  const text = body.trim();
  if (text === "") return { ok: false, error: "An empty note is not a note." };

  const { data, error } = await context.supabase
    .from("lead_events")
    .insert({
      org_id: context.orgId,
      lead_id: leadId,
      type: "note",
      actor_id: context.userId,
      payload: { body: text },
    })
    .select("id");

  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: "That note was refused. Is the lead in your org?" };
  }

  revalidatePath("/leads");
  revalidatePath("/pipeline");
  return { ok: true };
}
