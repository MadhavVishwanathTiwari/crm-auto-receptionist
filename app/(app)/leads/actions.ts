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
