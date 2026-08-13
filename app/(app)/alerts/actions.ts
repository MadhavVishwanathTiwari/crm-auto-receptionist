"use server";

import { revalidatePath } from "next/cache";

import { getOrgContext } from "@/lib/org";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/**
 * Marks an alert seen.
 *
 * Acknowledging is not the same as acting on it: a reply still has to be
 * answered from the mailbox, and the sequence has already halted itself off the
 * lead_events row the poller wrote. This only clears the badge, which is why
 * either operator may do it to any alert.
 */
export async function acknowledgeAlert(id: string): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };

  const { data, error } = await context.supabase
    .from("alerts")
    .update({
      acknowledged_at: new Date().toISOString(),
      acknowledged_by: context.userId,
    })
    .eq("id", id)
    .is("acknowledged_at", null)
    .select("id");

  if (error) return { ok: false, error: error.message };
  // Zero rows is either RLS refusing (204, no error) or someone else got there
  // first. Neither is worth an error banner: the desired state holds.
  if (!data || data.length === 0) {
    revalidatePath("/alerts");
    return { ok: true };
  }

  revalidatePath("/alerts");
  return { ok: true };
}

export async function acknowledgeAllAlerts(): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };

  const { error } = await context.supabase
    .from("alerts")
    .update({
      acknowledged_at: new Date().toISOString(),
      acknowledged_by: context.userId,
    })
    .eq("org_id", context.orgId)
    .is("acknowledged_at", null)
    .select("id");

  if (error) return { ok: false, error: error.message };

  revalidatePath("/alerts");
  return { ok: true };
}
