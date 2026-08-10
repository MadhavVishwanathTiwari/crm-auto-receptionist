"use server";

import { revalidatePath } from "next/cache";

import { getOrgContext } from "@/lib/org";

export type Decision = "merged" | "inserted_anyway" | "discarded";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/**
 * Resolves one near-duplicate.
 *
 * - `inserted_anyway` creates the lead: two contacts at one company are usually
 *   both worth having, which is why these were surfaced instead of dropped.
 * - `merged` keeps the existing lead and drops the candidate. It does not copy
 *   fields across — silently overwriting a lead an operator may have already
 *   corrected is worse than losing an enrichment we can re-import.
 * - `discarded` throws the candidate away.
 *
 * The candidate lives in `incoming`, so the decision still works after the
 * import that produced it is gone.
 */
export async function decideReview(
  reviewId: string,
  decision: Decision,
): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };
  const { supabase, orgId, userId } = context;

  const { data: review, error: readError } = await supabase
    .from("dedupe_reviews")
    .select("id, import_id, incoming, decision")
    .eq("id", reviewId)
    .maybeSingle();

  if (readError) return { ok: false, error: readError.message };
  if (!review) return { ok: false, error: "That review is no longer there." };
  if (review.decision !== "pending") {
    return { ok: false, error: "That one was already decided." };
  }

  let createdLeadId: string | null = null;

  if (decision === "inserted_anyway") {
    const { data: lead, error: insertError } = await supabase
      .from("leads")
      .insert({
        ...(review.incoming as Record<string, unknown>),
        org_id: orgId,
        import_id: review.import_id,
        source: "csv",
      })
      .select("id")
      .single();

    if (insertError) {
      // The org-wide unique on work_email_norm is the likely cause: the same
      // address arrived again between the import and this click.
      return { ok: false, error: `Could not create the lead: ${insertError.message}` };
    }
    createdLeadId = lead.id as string;
  }

  // .select() after the write, because a PostgREST UPDATE denied by RLS comes
  // back as 204 with zero rows and no error.
  const { data: updated, error: updateError } = await supabase
    .from("dedupe_reviews")
    .update({
      decision,
      decided_by: userId,
      decided_at: new Date().toISOString(),
      created_lead_id: createdLeadId,
    })
    .eq("id", reviewId)
    .eq("decision", "pending")
    .select("id");

  if (updateError) return { ok: false, error: updateError.message };
  if (!updated || updated.length === 0) {
    return { ok: false, error: "That review was decided by someone else first." };
  }

  revalidatePath("/review");
  revalidatePath("/leads");
  return { ok: true };
}
