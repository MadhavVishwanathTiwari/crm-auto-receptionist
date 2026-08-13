"use server";

import { IANAZone } from "luxon";
import { revalidatePath } from "next/cache";

import { getOrgContext } from "@/lib/org";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export interface MailboxSettingsInput {
  id: string;
  /** What a prospect sees in the From header, and what {{sender_name}} renders. */
  displayName: string;
  dailyCap: number;
  /** The MAILBOX's zone. Caps reset in this one, not the prospect's. */
  timezone: string;
}

/**
 * Edits the parts of a mailbox that belong to the operator.
 *
 * The address, the provider and the machine-maintained cursors are refused by
 * app.mailboxes_guard_protected_columns() rather than by this function, for the
 * same reason lead status is: a rule that lives only in the app holds until
 * something else writes the row.
 */
export async function updateMailboxSettings(
  input: MailboxSettingsInput,
): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };

  if (!Number.isInteger(input.dailyCap) || input.dailyCap < 0 || input.dailyCap > 500) {
    return { ok: false, error: "A daily cap has to be a whole number from 0 to 500." };
  }

  // Never guess a zone. An invalid one here would not corrupt a send time the
  // way a wrong lead zone does, but it would silently move the day the cap
  // resets in, which is the same class of mistake.
  if (!IANAZone.isValidZone(input.timezone)) {
    return { ok: false, error: `"${input.timezone}" is not an IANA timezone.` };
  }

  const { data, error } = await context.supabase
    .from("mailboxes")
    .update({
      display_name: input.displayName.trim() || null,
      daily_cap: input.dailyCap,
      timezone: input.timezone,
    })
    .eq("id", input.id)
    .select("id");

  if (error) return { ok: false, error: error.message };
  // A write refused by RLS is 204 with zero rows and no error.
  if (!data || data.length === 0) {
    return { ok: false, error: "That mailbox is not yours to edit." };
  }

  revalidatePath("/mailboxes");
  return { ok: true };
}

/**
 * Stops or restarts sending from a mailbox.
 *
 * Distinct from disconnected: pausing is a decision, and a paused mailbox is
 * still polled for replies, because a prospect who answers something already
 * sent still has to halt the sequence.
 */
export async function setMailboxPaused(
  id: string,
  paused: boolean,
): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };

  const { data, error } = await context.supabase
    .from("mailboxes")
    .update({ paused_at: paused ? new Date().toISOString() : null })
    .eq("id", id)
    .select("id");

  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: "That mailbox is not yours to pause." };
  }

  revalidatePath("/mailboxes");
  revalidatePath("/queue");
  return { ok: true };
}
