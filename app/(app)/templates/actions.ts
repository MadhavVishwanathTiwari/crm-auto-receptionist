"use server";

import { revalidatePath } from "next/cache";

import { getOrgContext } from "@/lib/org";
import { lintTemplateRules } from "@/lib/templates/lint";

export interface ActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

export interface TemplateInput {
  /** Absent for a new template. */
  id?: string | null;
  name: string;
  stepNumber: number;
  angleType: "soft_text_audit" | "voicemail_drop_audit" | null;
  subject: string;
  body: string;
  requiresDemo: boolean;
  isActive: boolean;
}

/**
 * Turns the trigger's refusal into something a human can act on.
 *
 * app.templates_enforce_lint() raises 23514 with the rule codes in the message.
 * The editor already lints as you type, so hitting this means the two
 * implementations disagreed — which the parity test exists to prevent, and
 * which is worth saying out loud rather than papering over.
 */
function describeError(error: { code?: string; message: string }): string {
  if (error.code === "23505") {
    return (
      "Another template is already active for that step and angle. " +
      "Deactivate it first, or give this one a different step."
    );
  }
  if (error.code === "23514" && error.message.includes("lint")) {
    return `The database refused this copy: ${error.message}`;
  }
  return error.message;
}

export async function saveTemplate(input: TemplateInput): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };

  const name = input.name.trim();
  if (!name) return { ok: false, error: "Give the template a name." };
  if (!Number.isInteger(input.stepNumber) || input.stepNumber < 1 || input.stepNumber > 4) {
    return { ok: false, error: "A step is 1, 2, 3 or 4." };
  }

  // Checked here as well as in the trigger so the message is about the copy
  // rather than about a constraint. The trigger is still the guarantee.
  if (input.isActive) {
    const rules = lintTemplateRules(input.subject, input.body);
    if (rules.length > 0) {
      return {
        ok: false,
        error: `This cannot go live yet: ${rules.join(", ")}.`,
      };
    }
  }

  const row = {
    org_id: context.orgId,
    name,
    step_number: input.stepNumber,
    angle_type: input.angleType,
    subject: input.subject,
    body: input.body,
    requires_demo: input.requiresDemo,
    is_active: input.isActive,
  };

  if (input.id) {
    const { data, error } = await context.supabase
      .from("templates")
      .update(row)
      .eq("id", input.id)
      .select("id");

    if (error) return { ok: false, error: describeError(error) };
    if (!data || data.length === 0) {
      return { ok: false, error: "That template was refused." };
    }
    revalidatePath("/templates");
    return { ok: true, id: input.id };
  }

  const { data, error } = await context.supabase
    .from("templates")
    .insert({ ...row, created_by: context.userId })
    .select("id");

  if (error) return { ok: false, error: describeError(error) };
  if (!data || data.length === 0) {
    return { ok: false, error: "That template was refused." };
  }

  revalidatePath("/templates");
  return { ok: true, id: data[0]!.id as string };
}

/** Activating is the moment the copy rules apply, because it is the moment it can reach a prospect. */
export async function setTemplateActive(
  id: string,
  active: boolean,
): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };

  const { data, error } = await context.supabase
    .from("templates")
    .update({ is_active: active })
    .eq("id", id)
    .select("id");

  if (error) return { ok: false, error: describeError(error) };
  if (!data || data.length === 0) {
    return { ok: false, error: "That change was refused." };
  }

  revalidatePath("/templates");
  revalidatePath("/queue");
  return { ok: true };
}

/** Admin-only at the policy level: a sent send points at the template it used. */
export async function deleteTemplate(id: string): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };

  const { data, error } = await context.supabase
    .from("templates")
    .delete()
    .eq("id", id)
    .select("id");

  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: "Only an admin can delete a template." };
  }

  revalidatePath("/templates");
  return { ok: true };
}
