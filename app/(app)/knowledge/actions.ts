"use server";

import { revalidatePath } from "next/cache";

import { getOrgContext } from "@/lib/org";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/**
 * Everything the assistant is allowed to know, and what it did with it.
 *
 * Writing here is writing what an autonomous sender says in somebody's name, so
 * every write below is admin-gated in the policy (0053) exactly as
 * org_settings is. A PostgREST write denied by RLS is 204 with zero rows and no
 * error, so each of these selects afterwards and reads an empty result as the
 * denial -- asserting `error !== null` would pass against a policy that let
 * everybody through.
 */

const MAX_CONTEXT = 8000;
const MAX_QUESTION = 300;
const MAX_ANSWER = 2000;

export async function updateBusinessContext(text: string): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };

  const trimmed = text.trim();
  if (trimmed.length > MAX_CONTEXT) {
    return {
      ok: false,
      error: `That is ${trimmed.length} characters; keep it under ${MAX_CONTEXT}. It is read on every single reply.`,
    };
  }

  const { data, error } = await context.supabase
    .from("org_settings")
    .update({ business_context: trimmed })
    .eq("org_id", context.orgId)
    .select("org_id");

  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: "Only an admin can change what the assistant knows." };
  }

  revalidatePath("/knowledge");
  return { ok: true };
}

export async function upsertKbEntry(input: {
  id?: string;
  question: string;
  answer: string;
  sortOrder?: number;
}): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };

  const question = input.question.trim();
  const answer = input.answer.trim();

  if (!question) return { ok: false, error: "An entry needs a question." };
  if (!answer) return { ok: false, error: "An entry needs an answer." };
  if (question.length > MAX_QUESTION) {
    return { ok: false, error: `Keep the question under ${MAX_QUESTION} characters.` };
  }
  if (answer.length > MAX_ANSWER) {
    return { ok: false, error: `Keep the answer under ${MAX_ANSWER} characters.` };
  }

  const query = input.id
    ? context.supabase
        .from("kb_entries")
        .update({ question, answer })
        .eq("id", input.id)
        .eq("org_id", context.orgId)
        .select("id")
    : context.supabase
        .from("kb_entries")
        .insert({
          org_id: context.orgId,
          question,
          answer,
          sort_order: input.sortOrder ?? 0,
          created_by: context.userId,
        })
        .select("id");

  const { data, error } = await query;
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: "Only an admin can change what the assistant knows." };
  }

  revalidatePath("/knowledge");
  return { ok: true };
}

export async function setKbEntryActive(
  id: string,
  isActive: boolean,
): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };

  const { data, error } = await context.supabase
    .from("kb_entries")
    .update({ is_active: isActive })
    .eq("id", id)
    .eq("org_id", context.orgId)
    .select("id");

  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: "Only an admin can change what the assistant knows." };
  }

  revalidatePath("/knowledge");
  return { ok: true };
}

export async function deleteKbEntry(id: string): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };

  const { data, error } = await context.supabase
    .from("kb_entries")
    .delete()
    .eq("id", id)
    .eq("org_id", context.orgId)
    .select("id");

  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: "Only an admin can change what the assistant knows." };
  }

  revalidatePath("/knowledge");
  return { ok: true };
}
