"use server";

import { revalidatePath } from "next/cache";

import { getOrgContext } from "@/lib/org";
import { bookSlot } from "@/lib/scheduler/book";
import {
  mailboxesForSend,
  pinnedMailboxIdFor,
  type RoutingBlock,
} from "@/lib/scheduler/routing";
import {
  earliestDayFor,
  loadWriteContext,
  nextStepFor,
  routingBlockMessage,
} from "@/lib/write/context";

/**
 * A composed email is dispatched verbatim, with no substitution pass, which is
 * what makes it immune to being skipped for a missing variable. The cost of
 * that is a leftover {{company_name}} goes out with the braces showing. The
 * composer checks as you type; this is the check that actually binds, because
 * the composer is a browser and a browser can be wrong.
 */
const LEFTOVER_VARIABLE = /\{\{\s*[a-z_]+\s*\}\}/i;

export interface QueueResult {
  ok: boolean;
  error?: string;
  /** What was actually booked, for the line the composer shows afterwards. */
  booked?: {
    sendId: string;
    step: number;
    /** ISO instant. The client renders it in the operator's own zone. */
    at: string;
    /** Prospect-local wall clock, no offset. */
    local: string;
    timezone: string;
    mailbox: string;
  };
}

/**
 * Books a hand-written email.
 *
 * The operator chooses the words. This chooses the moment, and that division is
 * the entire reason this app exists rather than a Gmail tab: a person writing
 * forty personal emails cannot also be the thing that remembers it is 6am in
 * Boise, that Thursday is the better weekday for a first touch, that this
 * mailbox has four sends left today and the other has eleven, and that a
 * federal holiday is coming.
 *
 * The slot is computed here rather than in the browser because the capacity it
 * depends on is org-wide and changes under the operator while they type. The
 * page's preview is computed from the same functions, so the two agree unless
 * somebody else booked something in between, which is exactly when the operator
 * should be told a different time.
 */
export async function queueWrittenEmail(input: {
  leadId: string;
  subject: string;
  body: string;
  /** Which template it was started from, if any. Provenance only. */
  templateId?: string | null;
}): Promise<QueueResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };
  const { supabase } = context;

  const subject = input.subject.trim();
  const body = input.body.trim();
  if (!subject) return { ok: false, error: "It needs a subject line." };
  if (!body) return { ok: false, error: "It needs a body." };

  if (LEFTOVER_VARIABLE.test(subject) || LEFTOVER_VARIABLE.test(body)) {
    return {
      ok: false,
      error:
        "That still has a {{variable}} in it, and a written email is sent exactly as typed.",
    };
  }

  const write = await loadWriteContext(supabase);
  if (!write) {
    return { ok: false, error: "This org has no settings row, so nothing can be scheduled." };
  }

  if (write.mailboxes.length === 0) {
    return {
      ok: false,
      error: "No sendable mailbox is connected. Connect one on Mailboxes.",
    };
  }

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("id, timezone, work_email, company_name, claimed_by")
    .eq("id", input.leadId)
    .maybeSingle();

  if (leadError) return { ok: false, error: leadError.message };
  if (!lead) return { ok: false, error: "That lead is no longer there." };
  if (!lead.timezone) {
    return {
      ok: false,
      error:
        "That lead has no timezone yet, so it can never be scheduled. Assign one on the lead.",
    };
  }

  const sends = write.sendsByLead.get(lead.id) ?? [];
  const step = nextStepFor(sends);

  if (!step.ok) {
    return {
      ok: false,
      error:
        step.reason === "in_flight"
          ? "That lead already has an email on its way out. Wait for it to land."
          : "That lead has had all four touches.",
    };
  }

  const zone = lead.timezone as string;

  // Whose mailbox, before which slot. An email you wrote leaves from your own
  // account, unless this lead's thread already started somewhere else, in which
  // case it has to stay there. The RPC below enforces the same rule; this is
  // what makes the message a sentence rather than a constraint violation.
  const routed = mailboxesForSend(write.mailboxes, {
    ownerId: lead.claimed_by as string | null,
    pinnedMailboxId: pinnedMailboxIdFor(sends),
    senders: write.senders,
  });

  if (!routed.ok) {
    return { ok: false, error: routingBlockMessage(routed.blocked as RoutingBlock) };
  }

  const slot = bookSlot({
    now: write.now,
    zone,
    earliestDay: earliestDayFor(
      step.step,
      step.lastSentAt,
      zone,
      write.now,
      write.holidays,
    ),
    step: step.step,
    // The lead and step, plus how many times this touch has been re-timed, so a
    // rebooked send lands on a different minute rather than colliding with the
    // same busy slot again. Same shape as the planner's seed.
    seed: `${lead.id}:${step.step}:${(step.replaces?.step_number ?? 0) + sends.length}`,
    settings: write.settings,
    mailboxes: routed.mailboxes,
    capacity: write.capacity,
    holidays: write.holidays,
  });

  if (!slot.ok) {
    // "no_mailbox" is unreachable now that routing has already returned a
    // non-empty list, but the exhaustive branch stays: it is one line, and the
    // alternative is a wrong message the day somebody changes routing.
    return {
      ok: false,
      error:
        slot.reason === "no_mailbox"
          ? "No sendable mailbox is connected."
          : routed.reason === "pinned"
            ? `${routed.pinnedTo?.email ?? "That mailbox"} is at its daily cap for the next ${write.settings.max_lookahead_days} days, and this lead's thread has to stay on it. Raise its cap on Mailboxes.`
            : `Your mailbox is full for the next ${write.settings.max_lookahead_days} days. Raise its daily cap on Mailboxes.`,
    };
  }

  const { data, error } = await supabase.rpc("queue_composed_send", {
    p_lead_id: lead.id,
    p_subject: subject,
    p_body: body,
    p_scheduled_at: slot.at.toUTC().toISO(),
    p_scheduled_local: slot.scheduledLocal,
    p_mailbox_id: slot.mailbox.id,
    p_step: step.step,
    p_template_id: input.templateId ?? null,
  });

  if (error) {
    // The RPC's own messages are written to be shown to an operator, so they
    // are passed through rather than replaced with something vaguer.
    return { ok: false, error: error.message };
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { id: string }
    | null
    | undefined;

  revalidatePath("/write");
  revalidatePath("/queue");
  revalidatePath("/leads");

  return {
    ok: true,
    booked: {
      sendId: row?.id ?? "",
      step: step.step,
      at: slot.at.toUTC().toISO()!,
      local: slot.scheduledLocal,
      timezone: zone,
      mailbox:
        write.mailboxes.find((m) => m.id === slot.mailbox.id)?.email ?? "",
    },
  };
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/**
 * Fixes the words of an email that has not left yet, without re-timing it.
 *
 * Deliberately not "cancel and re-queue": that would move the slot, and an
 * operator correcting a typo two minutes before send expects the send to stay
 * where it is.
 */
export async function reviseWrittenEmail(
  sendId: string,
  subject: string,
  body: string,
): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };

  if (LEFTOVER_VARIABLE.test(subject) || LEFTOVER_VARIABLE.test(body)) {
    return {
      ok: false,
      error:
        "That still has a {{variable}} in it, and a written email is sent exactly as typed.",
    };
  }

  const { error } = await context.supabase.rpc("revise_composed_send", {
    p_send_id: sendId,
    p_subject: subject.trim(),
    p_body: body.trim(),
  });

  if (error) return { ok: false, error: error.message };

  revalidatePath("/write");
  revalidatePath("/queue");
  return { ok: true };
}

/** Unbooks a send that has not left yet. Shared by the composer and the queue. */
export async function cancelSend(sendId: string): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };

  const { error } = await context.supabase.rpc("cancel_scheduled_send", {
    p_send_id: sendId,
    p_reason: "cancelled by operator",
  });

  if (error) return { ok: false, error: error.message };

  revalidatePath("/write");
  revalidatePath("/queue");
  revalidatePath("/leads");
  return { ok: true };
}
